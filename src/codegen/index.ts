import ts from "typescript";
import type { TypedAST } from "../checker/index.js";
import {
  mapTsTypeToWasm,
  isVoidType,
  isNumberType,
  isBooleanType,
  isStringType,
  isExternalDeclaredClass,
} from "../checker/type-mapper.js";
import type {
  WasmModule,
  WasmFunction,
  TypeDef,
  FuncTypeDef,
  StructTypeDef,
  ArrayTypeDef,
  ValType,
  Instr,
  LocalDef,
  Import,
  WasmExport,
  FieldDef,
} from "../ir/types.js";
import { createEmptyModule } from "../ir/types.js";
import { compileExpression } from "./expressions.js";
import { compileStatement } from "./statements.js";

/** Info about an externally declared class */
export interface ExternClassInfo {
  importPrefix: string;
  namespacePath: string[];
  className: string;
  constructorParams: ValType[];
  methods: Map<string, { params: ValType[]; results: ValType[] }>;
  properties: Map<string, { type: ValType; readonly: boolean }>;
}

/** Info about an optional parameter */
export interface OptionalParamInfo {
  index: number;
  type: ValType;
}

/** Context shared across all codegen */
export interface CodegenContext {
  mod: WasmModule;
  checker: ts.TypeChecker;
  /** Map from function name to its absolute index (imports + locals) */
  funcMap: Map<string, number>;
  /** Map from struct/interface name to type index */
  structMap: Map<string, number>;
  /** Map from struct name to field info */
  structFields: Map<string, FieldDef[]>;
  /** Number of imported functions */
  numImportFuncs: number;
  /** Current function context (set during function compilation) */
  currentFunc: FunctionContext | null;
  /** Errors accumulated during codegen */
  errors: { message: string; line: number; column: number }[];
  /** Registry of external declared classes */
  externClasses: Map<string, ExternClassInfo>;
  /** Optional parameter info per function */
  funcOptionalParams: Map<string, OptionalParamInfo[]>;
  /** Map from anonymous ts.Type → generated struct name */
  anonTypeMap: Map<ts.Type, string>;
  /** Counter for generating anonymous struct names */
  anonTypeCounter: number;
  /** Map from string literal value → import func name */
  stringLiteralMap: Map<string, string>;
  /** Map from import name → string literal value (for .d.ts comments) */
  stringLiteralValues: Map<string, string>;
  /** Counter for string literal imports */
  stringLiteralCounter: number;
  /** Whether wasm:js-string imports have been registered */
  hasStringImports: boolean;
  /** Map from "EnumName.Member" → numeric value */
  enumValues: Map<string, number>;
  /** Map from element kind (e.g. "f64") → registered array type index */
  arrayTypeMap: Map<string, number>;
  /** Map from className → parent className (for inheritance chain walk) */
  externClassParent: Map<string, string>;
  /** Map from global name (e.g. "document") → import info */
  declaredGlobals: Map<string, { type: ValType; funcIdx: number }>;
  /** Counter for generated callback functions (__cb_0, __cb_1, ...) */
  callbackCounter: number;
  /** Map from captured variable name → global index in mod.globals */
  capturedGlobals: Map<string, number>;
}

/** Per-function context */
export interface FunctionContext {
  /** Function name */
  name: string;
  /** Parameters (these are the first N locals) */
  params: { name: string; type: ValType }[];
  /** Additional locals declared in the body */
  locals: LocalDef[];
  /** All local names → index (params first, then locals) */
  localMap: Map<string, number>;
  /** Return type */
  returnType: ValType | null; // null = void
  /** Accumulated body instructions */
  body: Instr[];
  /** Block depth for br labels */
  blockDepth: number;
  /** Break label depth stack */
  breakStack: number[];
  /** Continue label depth stack */
  continueStack: number[];
}

/** Compile a typed AST into a WasmModule IR */
export function generateModule(ast: TypedAST): WasmModule {
  const mod = createEmptyModule();

  const ctx: CodegenContext = {
    mod,
    checker: ast.checker,
    funcMap: new Map(),
    structMap: new Map(),
    structFields: new Map(),
    numImportFuncs: 0,
    currentFunc: null,
    errors: [],
    externClasses: new Map(),
    funcOptionalParams: new Map(),
    anonTypeMap: new Map(),
    anonTypeCounter: 0,
    stringLiteralMap: new Map(),
    stringLiteralValues: new Map(),
    stringLiteralCounter: 0,
    hasStringImports: false,
    enumValues: new Map(),
    arrayTypeMap: new Map(),
    externClassParent: new Map(),
    declaredGlobals: new Map(),
    callbackCounter: 0,
    capturedGlobals: new Map(),
  };

  // Collect console.log imports (only variants actually used)
  collectConsoleImports(ctx, ast.sourceFile);

  // Collect primitive method imports (.toString() on numbers, etc.)
  collectPrimitiveMethodImports(ctx, ast.sourceFile);

  // First pass: collect declare namespaces (registers imports before local funcs)
  collectExternDeclarations(ctx, ast.sourceFile);

  // Scan lib.d.ts for DOM extern classes + globals (only if user code uses DOM)
  const libFile = ast.program.getSourceFile("lib.d.ts");
  if (libFile && sourceUsesDOMGlobals(ast.sourceFile)) {
    collectExternDeclarations(ctx, libFile);
    collectDeclaredGlobals(ctx, libFile);
  }

  // Register only the extern class imports actually used in source code
  collectUsedExternImports(ctx, ast.sourceFile);

  // Collect string literals and register imports (must be before local func indices)
  collectStringLiterals(ctx, ast.sourceFile);

  // Collect string method imports (.toUpperCase(), .indexOf(), etc.)
  collectStringMethodImports(ctx, ast.sourceFile);

  // Collect Math host imports for methods without native Wasm equivalents
  collectMathImports(ctx, ast.sourceFile);

  // Collect __make_callback import if arrow functions are used as call arguments
  collectCallbackImports(ctx, ast.sourceFile);

  // Register string literals for for-in field names (uses type checker, before func indices)
  collectForInStringLiterals(ctx, ast.sourceFile);

  // Second pass: collect all function declarations and interfaces
  collectDeclarations(ctx, ast.sourceFile);

  // Third pass: compile function bodies
  compileDeclarations(ctx, ast.sourceFile);

  // Copy metadata for .d.ts / helper generation
  for (const [key, info] of ctx.externClasses) {
    // Deduplicate: only add by className (skip full qualified duplicates)
    if (key === info.className) {
      mod.externClasses.push({
        importPrefix: info.importPrefix,
        namespacePath: info.namespacePath,
        className: info.className,
        constructorParams: info.constructorParams,
        methods: info.methods,
        properties: info.properties,
      });
    }
  }
  mod.stringLiteralValues = ctx.stringLiteralValues;

  return mod;
}

/** Scan source for console.log() calls and register only needed import variants */
function collectConsoleImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const needed = new Set<"number" | "bool" | "string" | "externref">();

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console" &&
      node.expression.name.text === "log"
    ) {
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
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    }
  }

  if (needed.has("number")) {
    const t = addFuncType(ctx, [{ kind: "f64" }], []);
    addImport(ctx, "env", "console_log_number", { kind: "func", typeIdx: t });
  }
  if (needed.has("bool")) {
    const t = addFuncType(ctx, [{ kind: "i32" }], []);
    addImport(ctx, "env", "console_log_bool", { kind: "func", typeIdx: t });
  }
  if (needed.has("string")) {
    const t = addFuncType(ctx, [{ kind: "externref" }], []);
    addImport(ctx, "env", "console_log_string", { kind: "func", typeIdx: t });
  }
  if (needed.has("externref")) {
    const t = addFuncType(ctx, [{ kind: "externref" }], []);
    addImport(ctx, "env", "console_log_externref", { kind: "func", typeIdx: t });
  }
}

/** Scan source for .toString() / .toFixed() on number types and register needed imports */
function collectPrimitiveMethodImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const needed = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const prop = node.expression;
      const receiverType = ctx.checker.getTypeAtLocation(prop.expression);
      const methodName = prop.name.text;
      if (isNumberType(receiverType) && methodName === "toString") {
        needed.add("number_toString");
      }
    }
    // Template expressions with number substitutions need number_toString
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        const spanType = ctx.checker.getTypeAtLocation(span.expression);
        if (isNumberType(spanType) || isBooleanType(spanType)) {
          needed.add("number_toString");
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    }
  }

  if (needed.has("number_toString")) {
    const t = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toString", { kind: "func", typeIdx: t });
  }
}

// String method signatures: name → { params (excluding self), resultKind }
const STRING_METHODS: Record<string, { params: ValType[]; result: ValType }> = {
  toUpperCase:  { params: [],                                 result: { kind: "externref" } },
  toLowerCase:  { params: [],                                 result: { kind: "externref" } },
  trim:         { params: [],                                 result: { kind: "externref" } },
  trimStart:    { params: [],                                 result: { kind: "externref" } },
  trimEnd:      { params: [],                                 result: { kind: "externref" } },
  charAt:       { params: [{ kind: "f64" }],                  result: { kind: "externref" } },
  slice:        { params: [{ kind: "f64" }, { kind: "f64" }], result: { kind: "externref" } },
  substring:    { params: [{ kind: "f64" }, { kind: "f64" }], result: { kind: "externref" } },
  indexOf:      { params: [{ kind: "externref" }],            result: { kind: "f64" } },
  lastIndexOf:  { params: [{ kind: "externref" }],            result: { kind: "f64" } },
  includes:     { params: [{ kind: "externref" }],            result: { kind: "i32" } },
  startsWith:   { params: [{ kind: "externref" }],            result: { kind: "i32" } },
  endsWith:     { params: [{ kind: "externref" }],            result: { kind: "i32" } },
  replace:      { params: [{ kind: "externref" }, { kind: "externref" }], result: { kind: "externref" } },
  repeat:       { params: [{ kind: "f64" }],                  result: { kind: "externref" } },
  padStart:     { params: [{ kind: "f64" }, { kind: "externref" }],       result: { kind: "externref" } },
  padEnd:       { params: [{ kind: "f64" }, { kind: "externref" }],       result: { kind: "externref" } },
};

/** Scan source for method calls on string types and register needed imports */
function collectStringMethodImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const needed = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const prop = node.expression;
      const receiverType = ctx.checker.getTypeAtLocation(prop.expression);
      const methodName = prop.name.text;
      if (isStringType(receiverType) && methodName in STRING_METHODS) {
        needed.add(methodName);
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    }
  }

  for (const method of needed) {
    const sig = STRING_METHODS[method]!;
    const params: ValType[] = [{ kind: "externref" }, ...sig.params]; // self + args
    const t = addFuncType(ctx, params, [sig.result]);
    addImport(ctx, "env", `string_${method}`, { kind: "func", typeIdx: t });
  }
}

/** Register wasm:js-string builtin imports (called on demand when strings are used) */
function addStringImports(ctx: CodegenContext): void {
  if (ctx.hasStringImports) return;
  ctx.hasStringImports = true;

  // concat: (externref, externref) -> externref
  const concatType = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  addImport(ctx, "wasm:js-string", "concat", {
    kind: "func",
    typeIdx: concatType,
  });

  // length: (externref) -> i32
  const lengthType = addFuncType(
    ctx,
    [{ kind: "externref" }],
    [{ kind: "i32" }],
  );
  addImport(ctx, "wasm:js-string", "length", {
    kind: "func",
    typeIdx: lengthType,
  });

  // equals: (externref, externref) -> i32
  const equalsType = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  addImport(ctx, "wasm:js-string", "equals", {
    kind: "func",
    typeIdx: equalsType,
  });

  // substring: (externref, i32, i32) -> externref
  const substringType = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "externref" }],
  );
  addImport(ctx, "wasm:js-string", "substring", {
    kind: "func",
    typeIdx: substringType,
  });

  // charCodeAt: (externref, i32) -> i32
  const charCodeAtType = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "i32" }],
  );
  addImport(ctx, "wasm:js-string", "charCodeAt", {
    kind: "func",
    typeIdx: charCodeAtType,
  });
}

/** Scan source for string literals and register env imports for each unique one */
function collectStringLiterals(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const literals = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node)) {
      literals.add(node.text);
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.add(node.text);
    }
    // Template expressions: collect head and span literal texts
    if (ts.isTemplateExpression(node)) {
      if (node.head.text) literals.add(node.head.text);
      for (const span of node.templateSpans) {
        if (span.literal.text) literals.add(span.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  // Only scan function bodies (skip declare namespaces, interfaces, etc.)
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    }
  }

  if (literals.size === 0) return;

  // Register wasm:js-string imports since we have strings
  addStringImports(ctx);

  // Register an env import for each unique string literal
  const strThunkType = addFuncType(ctx, [], [{ kind: "externref" }]);
  for (const value of literals) {
    const name = `__str_${ctx.stringLiteralCounter++}`;
    addImport(ctx, "env", name, { kind: "func", typeIdx: strThunkType });
    ctx.stringLiteralMap.set(value, name);
    ctx.stringLiteralValues.set(name, value);
    ctx.mod.stringPool.push(value);
  }
}

/** Register struct field names as string literals for for-in loops.
 *  Uses the type checker to get property names (runs before collectDeclarations). */
function collectForInStringLiterals(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const literals = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isForInStatement(node)) {
      const exprType = ctx.checker.getTypeAtLocation(node.expression);
      const props = exprType.getProperties();
      for (const prop of props) {
        if (!ctx.stringLiteralMap.has(prop.name)) literals.add(prop.name);
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    }
  }

  if (literals.size === 0) return;

  // Ensure wasm:js-string imports exist (may already be registered)
  addStringImports(ctx);

  const strThunkType = addFuncType(ctx, [], [{ kind: "externref" }]);
  for (const value of literals) {
    const name = `__str_${ctx.stringLiteralCounter++}`;
    addImport(ctx, "env", name, { kind: "func", typeIdx: strThunkType });
    ctx.stringLiteralMap.set(value, name);
    ctx.stringLiteralValues.set(name, value);
    ctx.mod.stringPool.push(value);
  }
}

/** Math methods that need host imports (no native Wasm opcode) */
const MATH_HOST_METHODS_1ARG = new Set([
  "exp", "log", "log2", "log10",
  "sin", "cos", "tan", "asin", "acos", "atan",
]);
const MATH_HOST_METHODS_2ARG = new Set(["pow", "atan2"]);

/** Scan source for Math.xxx() calls that need host imports */
function collectMathImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const needed = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Math"
    ) {
      const method = node.expression.name.text;
      if (MATH_HOST_METHODS_1ARG.has(method) || MATH_HOST_METHODS_2ARG.has(method) || method === "random") {
        needed.add(method);
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    }
  }

  for (const method of needed) {
    if (method === "random") {
      const typeIdx = addFuncType(ctx, [], [{ kind: "f64" }]);
      addImport(ctx, "env", `Math_${method}`, { kind: "func", typeIdx });
    } else if (MATH_HOST_METHODS_2ARG.has(method)) {
      const typeIdx = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", `Math_${method}`, { kind: "func", typeIdx });
    } else {
      const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", `Math_${method}`, { kind: "func", typeIdx });
    }
  }
}

/** Scan source for arrow functions used as call arguments and register __make_callback import */
function collectCallbackImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    }
    if (found) break;
  }

  if (found) {
    // __make_callback: (i32) → externref
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__make_callback", { kind: "func", typeIdx });
  }
}

export function addImport(
  ctx: CodegenContext,
  module: string,
  name: string,
  desc: Import["desc"],
): void {
  ctx.mod.imports.push({ module, name, desc });
  if (desc.kind === "func") {
    ctx.funcMap.set(name, ctx.numImportFuncs);
    ctx.numImportFuncs++;
  }
}

export function addFuncType(
  ctx: CodegenContext,
  params: ValType[],
  results: ValType[],
  name?: string,
): number {
  // Check if an equivalent type already exists
  for (let i = 0; i < ctx.mod.types.length; i++) {
    const t = ctx.mod.types[i]!;
    if (t.kind === "func" && funcTypeEq(t, params, results)) {
      return i;
    }
  }
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "func",
    name: name ?? `type${idx}`,
    params,
    results,
  });
  return idx;
}

function funcTypeEq(
  t: FuncTypeDef,
  params: ValType[],
  results: ValType[],
): boolean {
  if (t.params.length !== params.length) return false;
  if (t.results.length !== results.length) return false;
  for (let i = 0; i < params.length; i++) {
    if (!valTypeEq(t.params[i]!, params[i]!)) return false;
  }
  for (let i = 0; i < results.length; i++) {
    if (!valTypeEq(t.results[i]!, results[i]!)) return false;
  }
  return true;
}

function valTypeEq(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if (
    (a.kind === "ref" || a.kind === "ref_null") &&
    (b.kind === "ref" || b.kind === "ref_null")
  ) {
    return a.typeIdx === (b as { typeIdx: number }).typeIdx;
  }
  return true;
}

// ── Type resolution ──────────────────────────────────────────────────

/**
 * Get or register a Wasm array type for a given element kind.
 * Reuses existing registrations so each element type only gets one array type.
 */
export function getOrRegisterArrayType(ctx: CodegenContext, elemKind: string): number {
  if (ctx.arrayTypeMap.has(elemKind)) return ctx.arrayTypeMap.get(elemKind)!;
  const elemType: ValType =
    elemKind === "f64" ? { kind: "f64" } :
    elemKind === "i32" ? { kind: "i32" } :
    { kind: "externref" };
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: `__arr_${elemKind}`,
    element: elemType,
    mutable: true,
  } as ArrayTypeDef);
  ctx.arrayTypeMap.set(elemKind, idx);
  return idx;
}

/**
 * Resolve a ts.Type to a ValType, using the struct registry and anonymous type map.
 * Use this instead of mapTsTypeToWasm in the codegen to get real type indices.
 */
export function resolveWasmType(ctx: CodegenContext, tsType: ts.Type): ValType {
  if (isExternalDeclaredClass(tsType)) return { kind: "externref" };

  if (tsType.flags & ts.TypeFlags.Object) {
    // Handle Array<T> / T[] types — must check before named struct lookup
    const sym = (tsType as ts.TypeReference).symbol ?? (tsType as ts.Type).symbol;
    if (sym?.name === "Array") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      const elemType = typeArgs[0];
      const elemKind = elemType ? mapTsTypeToWasm(elemType, ctx.checker).kind : "externref";
      // Only use Wasm GC arrays for primitive element types (f64, i32).
      // Arrays of externref (objects, strings, any[]) stay as externref since
      // they typically come from JS across the boundary, not from array.new_fixed.
      if (elemKind === "f64" || elemKind === "i32") {
        const arrTypeIdx = getOrRegisterArrayType(ctx, elemKind);
        return { kind: "ref", typeIdx: arrTypeIdx };
      }
      return { kind: "externref" };
    }

    const name = sym?.name;
    // Check named structs (interfaces, type aliases)
    if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) {
      return { kind: "ref", typeIdx: ctx.structMap.get(name)! };
    }
    // Check anonymous type registry
    const anonName = ctx.anonTypeMap.get(tsType);
    if (anonName && ctx.structMap.has(anonName)) {
      return { kind: "ref", typeIdx: ctx.structMap.get(anonName)! };
    }
  }

  // Handle unions (T | undefined) — resolve inner type
  if (tsType.isUnion()) {
    const nonNullish = tsType.types.filter(
      (t) =>
        !(t.flags & ts.TypeFlags.Null) &&
        !(t.flags & ts.TypeFlags.Undefined),
    );
    if (nonNullish.length === 1 && tsType.types.length === 2) {
      const inner = resolveWasmType(ctx, nonNullish[0]!);
      if (inner.kind === "ref") return { kind: "ref_null", typeIdx: inner.typeIdx };
      return inner;
    }
  }

  return mapTsTypeToWasm(tsType, ctx.checker);
}

/**
 * Ensure a ts.Type that's an object type is registered as a struct.
 * For named types already in structMap, this is a no-op.
 * For anonymous types, auto-registers them with a generated name.
 */
function ensureStructForType(ctx: CodegenContext, tsType: ts.Type): void {
  if (!(tsType.flags & ts.TypeFlags.Object)) return;
  if (isExternalDeclaredClass(tsType)) return;

  const name = tsType.symbol?.name;

  // Already registered as named struct
  if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) return;

  // Already registered as anonymous struct
  if (ctx.anonTypeMap.has(tsType)) return;

  // Get properties from the type
  const props = tsType.getProperties();
  if (props.length === 0) return;

  const fields: FieldDef[] = [];
  for (const prop of props) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    // Use mapTsTypeToWasm for fields — they'll be resolved later or are primitives
    const wasmType = mapTsTypeToWasm(propType, ctx.checker);
    fields.push({ name: prop.name, type: wasmType, mutable: true });
  }

  const structName = `__anon_${ctx.anonTypeCounter++}`;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: structName, fields } as StructTypeDef);
  ctx.structMap.set(structName, typeIdx);
  ctx.structFields.set(structName, fields);
  ctx.anonTypeMap.set(tsType, structName);
}

// ── Extern class collection ──────────────────────────────────────────

function collectExternDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  for (const stmt of sourceFile.statements) {
    if (ts.isModuleDeclaration(stmt) && hasDeclareModifier(stmt)) {
      collectDeclareNamespace(ctx, stmt, []);
    }
    // Top-level declare class (e.g. DOM types from lib.d.ts)
    if (ts.isClassDeclaration(stmt) && stmt.name && hasDeclareModifier(stmt)) {
      collectExternClass(ctx, stmt, []);
    }
  }
}

function collectDeclareNamespace(
  ctx: CodegenContext,
  decl: ts.ModuleDeclaration,
  parentPath: string[],
): void {
  const nsName = decl.name.text;
  const path = [...parentPath, nsName];

  if (decl.body && ts.isModuleBlock(decl.body)) {
    for (const stmt of decl.body.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name) {
        collectExternClass(ctx, stmt, path);
      }
      if (ts.isModuleDeclaration(stmt)) {
        collectDeclareNamespace(ctx, stmt, path);
      }
    }
  }
}

function collectExternClass(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration,
  namespacePath: string[],
): void {
  const className = decl.name!.text;
  const prefix = [...namespacePath, className].join("_");

  const info: ExternClassInfo = {
    importPrefix: prefix,
    namespacePath,
    className,
    constructorParams: [],
    methods: new Map(),
    properties: new Map(),
  };

  for (const member of decl.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        info.constructorParams.push(mapTsTypeToWasm(paramType, ctx.checker));
      }
    }
    if (ts.isMethodDeclaration(member) && member.name) {
      const methodName = (member.name as ts.Identifier).text;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      if (sig) {
        const params: ValType[] = [{ kind: "externref" }]; // 'this'
        for (const p of member.parameters) {
          const pt = ctx.checker.getTypeAtLocation(p);
          params.push(mapTsTypeToWasm(pt, ctx.checker));
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        const results: ValType[] = isVoidType(retType)
          ? []
          : [mapTsTypeToWasm(retType, ctx.checker)];
        info.methods.set(methodName, { params, results });
      }
    }
    if (ts.isPropertyDeclaration(member) && member.name) {
      const propName = (member.name as ts.Identifier).text;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
      const isReadonly =
        member.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword,
        ) ?? false;
      info.properties.set(propName, { type: wasmType, readonly: isReadonly });
    }
  }

  // Record parent class for inheritance chain walk
  if (decl.heritageClauses) {
    for (const clause of decl.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types[0]) {
        const baseType = ctx.checker.getTypeAtLocation(clause.types[0]);
        const baseName = baseType.getSymbol()?.name;
        if (baseName) ctx.externClassParent.set(className, baseName);
      }
    }
  }

  ctx.externClasses.set(className, info);
  // Also register with full qualified name
  const fullName = [...namespacePath, className].join(".");
  ctx.externClasses.set(fullName, info);
}

function registerExternClassImports(
  ctx: CodegenContext,
  info: ExternClassInfo,
): void {
  // Constructor
  const ctorTypeIdx = addFuncType(
    ctx,
    info.constructorParams,
    [{ kind: "externref" }],
  );
  addImport(ctx, "env", `${info.importPrefix}_new`, {
    kind: "func",
    typeIdx: ctorTypeIdx,
  });

  // Methods
  for (const [methodName, sig] of info.methods) {
    const methodTypeIdx = addFuncType(ctx, sig.params, sig.results);
    addImport(ctx, "env", `${info.importPrefix}_${methodName}`, {
      kind: "func",
      typeIdx: methodTypeIdx,
    });
  }

  // Property getters and setters
  for (const [propName, propInfo] of info.properties) {
    const getterTypeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }],
      [propInfo.type],
    );
    addImport(ctx, "env", `${info.importPrefix}_get_${propName}`, {
      kind: "func",
      typeIdx: getterTypeIdx,
    });

    if (!propInfo.readonly) {
      const setterTypeIdx = addFuncType(
        ctx,
        [{ kind: "externref" }, propInfo.type],
        [],
      );
      addImport(ctx, "env", `${info.importPrefix}_set_${propName}`, {
        kind: "func",
        typeIdx: setterTypeIdx,
      });
    }
  }
}

/** Scan user code and register only the extern class imports actually used */
function collectUsedExternImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const registered = new Set<string>();

  function resolveExtern(
    className: string,
    memberName: string,
    kind: "method" | "property",
  ): ExternClassInfo | null {
    let current: string | undefined = className;
    while (current) {
      const info = ctx.externClasses.get(current);
      if (info) {
        if (kind === "method" && info.methods.has(memberName)) return info;
        if (kind === "property" && info.properties.has(memberName)) return info;
      }
      current = ctx.externClassParent.get(current);
    }
    return null;
  }

  function register(importName: string, params: ValType[], results: ValType[]) {
    if (registered.has(importName)) return;
    registered.add(importName);
    const t = addFuncType(ctx, params, results);
    addImport(ctx, "env", importName, { kind: "func", typeIdx: t });
  }

  function visit(node: ts.Node) {
    // new ClassName()
    if (ts.isNewExpression(node)) {
      const type = ctx.checker.getTypeAtLocation(node);
      const className = type.getSymbol()?.name;
      if (className) {
        const info = ctx.externClasses.get(className);
        if (info) register(`${info.importPrefix}_new`, info.constructorParams, [{ kind: "externref" }]);
      }
    }

    // obj.prop or obj.method(...)
    if (ts.isPropertyAccessExpression(node)) {
      // Skip if this is the target of an assignment (setter handled below)
      const isAssignTarget =
        node.parent &&
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.parent.left === node;

      if (!isAssignTarget) {
        const objType = ctx.checker.getTypeAtLocation(node.expression);
        const className = objType.getSymbol()?.name;
        const memberName = node.name.text;
        if (className) {
          const isCall =
            node.parent &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression === node;
          if (isCall) {
            const info = resolveExtern(className, memberName, "method");
            if (info) {
              const sig = info.methods.get(memberName)!;
              register(`${info.importPrefix}_${memberName}`, sig.params, sig.results);
            }
          } else {
            const info = resolveExtern(className, memberName, "property");
            if (info) {
              const propInfo = info.properties.get(memberName)!;
              register(`${info.importPrefix}_get_${memberName}`, [{ kind: "externref" }], [propInfo.type]);
            }
          }
        }
      }
    }

    // obj.prop = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const objType = ctx.checker.getTypeAtLocation(node.left.expression);
      const className = objType.getSymbol()?.name;
      const propName = node.left.name.text;
      if (className) {
        const info = resolveExtern(className, propName, "property");
        if (info) {
          const propInfo = info.properties.get(propName)!;
          register(`${info.importPrefix}_set_${propName}`, [{ kind: "externref" }, propInfo.type], []);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    }
  }
}

// ── Declared globals (e.g. declare const document: Document) ────────

function collectDeclaredGlobals(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt) || !hasDeclareModifier(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (ctx.declaredGlobals.has(name)) continue; // already registered
      const type = ctx.checker.getTypeAtLocation(decl);
      if (!isExternalDeclaredClass(type)) continue;
      const importName = `global_${name}`;
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        ctx.declaredGlobals.set(name, { type: { kind: "externref" }, funcIdx });
      }
    }
  }
}

/** Check if source code references DOM globals (document, window) */
function sourceUsesDOMGlobals(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && (node.text === "document" || node.text === "window")) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const stmt of sourceFile.statements) {
    ts.forEachChild(stmt, visit);
    if (found) break;
  }
  return found;
}

// ── Regular declaration collection ───────────────────────────────────

/** Collect enum declarations into ctx.enumValues */
function collectEnumDeclarations(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  for (const stmt of sourceFile.statements) {
    if (!ts.isEnumDeclaration(stmt)) continue;
    const enumName = stmt.name.text;
    let nextValue = 0;
    for (const member of stmt.members) {
      const memberName = (member.name as ts.Identifier).text;
      const key = `${enumName}.${memberName}`;
      if (member.initializer) {
        if (ts.isNumericLiteral(member.initializer)) {
          nextValue = Number(member.initializer.text);
        } else if (
          ts.isPrefixUnaryExpression(member.initializer) &&
          member.initializer.operator === ts.SyntaxKind.MinusToken &&
          ts.isNumericLiteral(member.initializer.operand)
        ) {
          nextValue = -Number((member.initializer.operand as ts.NumericLiteral).text);
        }
      }
      ctx.enumValues.set(key, nextValue);
      nextValue++;
    }
  }
}

/** Collect all function declarations and interfaces */
function collectDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
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

  // Third: collect function declarations (uses resolveWasmType for real type indices)
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      // Skip declare function stubs (no body, inside or matching declare)
      if (hasDeclareModifier(stmt)) continue;

      const name = stmt.name.text;
      const sig = ctx.checker.getSignatureFromDeclaration(stmt);
      if (!sig) continue;

      // Ensure anonymous types in signature are registered as structs
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      if (!isVoidType(retType)) ensureStructForType(ctx, retType);
      for (const p of stmt.parameters) {
        const pt = ctx.checker.getTypeAtLocation(p);
        ensureStructForType(ctx, pt);
      }

      const params: ValType[] = [];
      const optionalParams: OptionalParamInfo[] = [];
      for (let i = 0; i < stmt.parameters.length; i++) {
        const param = stmt.parameters[i]!;
        const paramType = ctx.checker.getTypeAtLocation(param);
        const wasmType = resolveWasmType(ctx, paramType);
        params.push(wasmType);
        if (param.questionToken) {
          optionalParams.push({ index: i, type: wasmType });
        }
      }

      if (optionalParams.length > 0) {
        ctx.funcOptionalParams.set(name, optionalParams);
      }

      const results: ValType[] = isVoidType(retType)
        ? []
        : [resolveWasmType(ctx, retType)];

      const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
      const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(name, funcIdx);

      // Create placeholder function to be filled in second pass
      const isExported = hasExportModifier(stmt);
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
      }
    }
  }
}

function collectInterface(
  ctx: CodegenContext,
  decl: ts.InterfaceDeclaration,
): void {
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
  ctx.structFields.set(name, fields);
}

function collectObjectType(
  ctx: CodegenContext,
  name: string,
  type: ts.Type,
): void {
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
    ctx.structFields.set(name, fields);
  }
}

/** Compile all function bodies */
function compileDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  let funcIdx = 0;
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && !hasDeclareModifier(stmt)) {
      if (stmt.body) {
        const func = ctx.mod.functions[funcIdx]!;
        compileFunctionBody(ctx, stmt, func);
      }
      funcIdx++;
    }
  }
}

function compileFunctionBody(
  ctx: CodegenContext,
  decl: ts.FunctionDeclaration,
  func: WasmFunction,
): void {
  const sig = ctx.checker.getSignatureFromDeclaration(decl)!;
  const retType = ctx.checker.getReturnTypeOfSignature(sig);

  const params: { name: string; type: ValType }[] = [];
  for (const param of decl.parameters) {
    const paramName = (param.name as ts.Identifier).text;
    const paramType = ctx.checker.getTypeAtLocation(param);
    params.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
  }

  const fctx: FunctionContext = {
    name: func.name,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoidType(retType) ? null : resolveWasmType(ctx, retType),
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
  };

  // Register params as locals
  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i]!.name, i);
  }

  ctx.currentFunc = fctx;

  // Compile body statements
  if (decl.body) {
    for (const stmt of decl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  // Ensure there's always a valid return value at the end for non-void functions
  if (fctx.returnType) {
    // Check if the last instruction is already a return
    const lastInstr = fctx.body[fctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      // Add a default return value
      if (fctx.returnType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (fctx.returnType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (fctx.returnType.kind === "externref") {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (fctx.returnType.kind === "ref" || fctx.returnType.kind === "ref_null") {
        fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
      }
    }
  }

  func.locals = fctx.locals;
  func.body = fctx.body;

  ctx.currentFunc = null;
}

/** Allocate a new local in the current function */
export function allocLocal(
  fctx: FunctionContext,
  name: string,
  type: ValType,
): number {
  const index = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name, type });
  fctx.localMap.set(name, index);
  return index;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasDeclareModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
}

/**
 * Ensure the stack top is an i32 suitable for use as a condition.
 * Handles: f64 (truthy != 0), externref (non-null check), null (push 0).
 */
export function ensureI32Condition(fctx: FunctionContext, condType: ValType | null): void {
  if (!condType) {
    // Expression compilation failed — push false to keep Wasm valid
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }
  if (condType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.ne" });
  } else if (condType.kind === "externref") {
    // Truthiness for externref: non-null → true
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" }); // flip: is_null=1 means falsy
  }
  // i32 is already valid as-is
}

export { compileExpression } from "./expressions.js";
export { compileStatement } from "./statements.js";
