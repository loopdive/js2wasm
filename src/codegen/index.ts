import ts from "typescript";
import type { TypedAST, MultiTypedAST } from "../checker/index.js";
import {
  mapTsTypeToWasm,
  isVoidType,
  isNumberType,
  isBooleanType,
  isStringType,
  isExternalDeclaredClass,
  isHeterogeneousUnion,
  isPromiseType,
  unwrapPromiseType,
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
  TagDef,
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
  methods: Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>;
  properties: Map<string, { type: ValType; readonly: boolean }>;
}

/** Info about an optional parameter */
export interface OptionalParamInfo {
  index: number;
  type: ValType;
}

/** Info about a rest parameter */
export interface RestParamInfo {
  /** Index of the rest parameter in the original TS signature */
  restIndex: number;
  /** Element type of the rest array (e.g. f64 for number[]) */
  elemType: ValType;
  /** Array type index in the module types */
  arrayTypeIdx: number;
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
  /** Map from element kind (e.g. "f64") → registered vec struct type index */
  vecTypeMap: Map<string, number>;
  /** Map from className → parent className (for inheritance chain walk) */
  externClassParent: Map<string, string>;
  /** Map from global name (e.g. "document") → import info */
  declaredGlobals: Map<string, { type: ValType; funcIdx: number }>;
  /** Counter for generated callback functions (__cb_0, __cb_1, ...) */
  callbackCounter: number;
  /** Map from captured variable name → global index in mod.globals */
  capturedGlobals: Map<string, number>;
  /** Captured globals whose type was widened from ref to ref_null for null init */
  capturedGlobalsWidened: Set<string>;
  /** Set of class names (local classes compiled to Wasm GC structs) */
  classSet: Set<string>;
  /** Map from "ClassName_methodName" → method info for local classes */
  classMethodSet: Set<string>;
  /** Counter for generated closure types/functions */
  closureCounter: number;
  /** Map from local variable name → closure metadata (for call_ref dispatch) */
  closureMap: Map<string, ClosureInfo>;
  /** Resolved concrete types for generic functions (from call-site analysis) */
  genericResolved: Map<string, { params: ValType[]; results: ValType[] }>;
  /** Rest parameter info per function (functions with ...rest syntax) */
  funcRestParams: Map<string, RestParamInfo>;
  /** Tag index for the exception tag (-1 if not yet registered) */
  exnTagIdx: number;
  /** Whether union type helper imports have been registered */
  hasUnionImports: boolean;
  /** Set of function names that are async (for .d.ts generation) */
  asyncFunctions: Set<string>;
  /** Map from module-level variable name → global index in mod.globals */
  moduleGlobals: Map<string, number>;
  /** Module-level variable initializers (compiled into __module_init) */
  moduleInitStatements: ts.Statement[];
}

/** Metadata for a closure stored in a local variable */
export interface ClosureInfo {
  /** Type index of the closure struct */
  structTypeIdx: number;
  /** Type index of the inner function type (for call_ref) */
  funcTypeIdx: number;
  /** Return type of the closure */
  returnType: ValType | null;
  /** Parameter types of the closure (excluding the closure struct self param) */
  paramTypes: ValType[];
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
    vecTypeMap: new Map(),
    externClassParent: new Map(),
    declaredGlobals: new Map(),
    callbackCounter: 0,
    capturedGlobals: new Map(),
    capturedGlobalsWidened: new Set(),
    classSet: new Set(),
    classMethodSet: new Set(),
    closureCounter: 0,
    closureMap: new Map(),
    genericResolved: new Map(),
    funcRestParams: new Map(),
    exnTagIdx: -1,
    hasUnionImports: false,
    asyncFunctions: new Set(),
    moduleGlobals: new Map(),
    moduleInitStatements: [],
  };

  // Collect console.log imports (only variants actually used)
  collectConsoleImports(ctx, ast.sourceFile);

  // Collect primitive method imports (.toString() on numbers, etc.)
  collectPrimitiveMethodImports(ctx, ast.sourceFile);

  // First pass: collect declare namespaces (registers imports before local funcs)
  collectExternDeclarations(ctx, ast.sourceFile);

  // Scan lib.d.ts for DOM extern classes + globals (only if user code uses DOM)
  const libFile = ast.program.getSourceFile("lib.d.ts");
  if (libFile && sourceUsesLibGlobals(ast.sourceFile)) {
    collectExternDeclarations(ctx, libFile);
    collectDeclaredGlobals(ctx, libFile, ast.sourceFile);
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

  // Collect union type helper imports (typeof checks, boxing/unboxing)
  collectUnionImports(ctx, ast.sourceFile);

  // Register string literals for for-in field names (uses type checker, before func indices)
  collectForInStringLiterals(ctx, ast.sourceFile);

  // Second pass: collect all function declarations and interfaces
  collectDeclarations(ctx, ast.sourceFile);

  // Third pass: compile function bodies
  compileDeclarations(ctx, ast.sourceFile);

  // Copy metadata for .d.ts / helper generation — only include actually-used extern classes
  const importNames = mod.imports.map((imp) => imp.name);
  for (const [key, info] of ctx.externClasses) {
    const prefix = info.importPrefix + "_";
    const isUsed = importNames.some((n) => n.startsWith(prefix));
    if (key === info.className && isUsed) {
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
  mod.asyncFunctions = ctx.asyncFunctions;

  return mod;
}

/**
 * Compile multiple typed source files into a single WasmModule IR.
 * All source files share the same codegen context (funcMap, structMap, etc.).
 * Only functions exported from the entry file become Wasm exports.
 */
export function generateMultiModule(multiAst: MultiTypedAST): WasmModule {
  const mod = createEmptyModule();

  const ctx: CodegenContext = {
    mod,
    checker: multiAst.checker,
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
    vecTypeMap: new Map(),
    externClassParent: new Map(),
    declaredGlobals: new Map(),
    callbackCounter: 0,
    capturedGlobals: new Map(),
    capturedGlobalsWidened: new Set(),
    classSet: new Set(),
    classMethodSet: new Set(),
    closureCounter: 0,
    closureMap: new Map(),
    genericResolved: new Map(),
    funcRestParams: new Map(),
    hasUnionImports: false,
    asyncFunctions: new Set(),
    exnTagIdx: -1,
    moduleGlobals: new Map(),
    moduleInitStatements: [],
  };

  // Phase 1: Collect all import-phase declarations across all source files
  for (const sf of multiAst.sourceFiles) {
    collectConsoleImports(ctx, sf);
    collectPrimitiveMethodImports(ctx, sf);
    collectExternDeclarations(ctx, sf);
  }

  // Scan lib.d.ts for DOM extern classes + globals (only if any user code uses DOM)
  const libFile = multiAst.program.getSourceFile("lib.d.ts");
  if (libFile) {
    const anyUsesDom = multiAst.sourceFiles.some((sf) => sourceUsesLibGlobals(sf));
    if (anyUsesDom) {
      collectExternDeclarations(ctx, libFile);
      for (const sf of multiAst.sourceFiles) {
        if (sourceUsesLibGlobals(sf)) {
          collectDeclaredGlobals(ctx, libFile, sf);
        }
      }
    }
  }

  for (const sf of multiAst.sourceFiles) {
    collectUsedExternImports(ctx, sf);
    collectStringLiterals(ctx, sf);
    collectStringMethodImports(ctx, sf);
    collectMathImports(ctx, sf);
    collectCallbackImports(ctx, sf);
    collectUnionImports(ctx, sf);
    collectForInStringLiterals(ctx, sf);
  }

  // Phase 2: Collect all declarations — only entry file gets Wasm exports
  for (const sf of multiAst.sourceFiles) {
    const isEntry = sf === multiAst.entryFile;
    collectDeclarations(ctx, sf, isEntry);
  }

  // Phase 3: Compile all function bodies
  for (const sf of multiAst.sourceFiles) {
    compileDeclarations(ctx, sf);
  }

  // Copy metadata for .d.ts / helper generation
  const importNames = mod.imports.map((imp) => imp.name);
  for (const [key, info] of ctx.externClasses) {
    const prefix = info.importPrefix + "_";
    const isUsed = importNames.some((n) => n.startsWith(prefix));
    if (key === info.className && isUsed) {
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
  mod.asyncFunctions = ctx.asyncFunctions;

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
      if (isNumberType(receiverType) && methodName === "toFixed") {
        needed.add("number_toFixed");
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
  if (needed.has("number_toFixed")) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toFixed", { kind: "func", typeIdx: t });
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
    // ** and **= operators need Math.pow
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
        node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)
    ) {
      needed.add("pow");
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
    // __make_callback: (i32, externref) → externref
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__make_callback", { kind: "func", typeIdx });
  }
}

/** Scan source for union types (number | string, etc.) and register needed helper imports */
function collectUnionImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    // Check function parameter types for heterogeneous unions
    if (ts.isFunctionDeclaration(node) && node.parameters) {
      for (const param of node.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        if (isHeterogeneousUnion(paramType, ctx.checker)) {
          found = true;
          return;
        }
      }
    }
    // Check variable declarations for union types
    if (ts.isVariableDeclaration(node) && node.type) {
      const varType = ctx.checker.getTypeAtLocation(node);
      if (isHeterogeneousUnion(varType, ctx.checker)) {
        found = true;
        return;
      }
    }
    // Check for typeof expressions (used in narrowing)
    if (ts.isTypeOfExpression(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt);
    }
  }

  if (found) {
    addUnionImports(ctx);
  }
}

/** Register union type helper imports (typeof checks, boxing/unboxing) */
export function addUnionImports(ctx: CodegenContext): void {
  if (ctx.hasUnionImports) return;
  ctx.hasUnionImports = true;

  // __typeof_number: (externref) → i32
  const typeofType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__typeof_number", { kind: "func", typeIdx: typeofType });
  addImport(ctx, "env", "__typeof_string", { kind: "func", typeIdx: typeofType });
  addImport(ctx, "env", "__typeof_boolean", { kind: "func", typeIdx: typeofType });

  // __is_truthy: (externref) → i32
  addImport(ctx, "env", "__is_truthy", { kind: "func", typeIdx: typeofType });

  // __unbox_number: (externref) → f64
  const unboxNumType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
  addImport(ctx, "env", "__unbox_number", { kind: "func", typeIdx: unboxNumType });

  // __unbox_boolean: (externref) → i32
  addImport(ctx, "env", "__unbox_boolean", { kind: "func", typeIdx: typeofType });

  // __box_number: (f64) → externref
  const boxNumType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxNumType });

  // __box_boolean: (i32) → externref
  const boxBoolType = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__box_boolean", { kind: "func", typeIdx: boxBoolType });
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

/**
 * Lazily register the exception tag used by throw/try-catch.
 * The tag has signature (externref) — all thrown values are externref.
 * Returns the tag index (currently always 0 since we only have one tag).
 */
export function ensureExnTag(ctx: CodegenContext): number {
  if (ctx.exnTagIdx >= 0) return ctx.exnTagIdx;
  // Create a func type for the tag: (param externref) — no results
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], []);
  const tagDef: TagDef = { name: "__exn", typeIdx };
  ctx.exnTagIdx = ctx.mod.tags.length;
  ctx.mod.tags.push(tagDef);
  return ctx.exnTagIdx;
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
export function getOrRegisterArrayType(ctx: CodegenContext, elemKind: string, elemTypeOverride?: ValType): number {
  if (ctx.arrayTypeMap.has(elemKind)) return ctx.arrayTypeMap.get(elemKind)!;
  const elemType: ValType = elemTypeOverride ??
    (elemKind === "f64" ? { kind: "f64" } :
    elemKind === "i32" ? { kind: "i32" } :
    { kind: "externref" });
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
 * Get or register a vec struct type wrapping a Wasm GC array.
 * The vec struct has {length: i32, data: (ref $__arr_<elemKind>)}.
 * Reuses existing registrations so each element type only gets one vec type.
 */
export function getOrRegisterVecType(
  ctx: CodegenContext,
  elemKind: string,
  elemTypeOverride?: ValType,
): number {
  const existing = ctx.vecTypeMap.get(elemKind);
  if (existing !== undefined) return existing;

  const arrTypeIdx = getOrRegisterArrayType(ctx, elemKind, elemTypeOverride);
  const vecIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `__vec_${elemKind}`,
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx }, mutable: true },
    ],
  });
  ctx.vecTypeMap.set(elemKind, vecIdx);
  return vecIdx;
}

/** Get the raw array type index from a vec struct type index. */
export function getArrTypeIdxFromVec(ctx: CodegenContext, vecTypeIdx: number): number {
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") throw new Error("not a vec type");
  const dataField = vecDef.fields[1]!;
  if (dataField.type.kind !== "ref") throw new Error("vec data field not ref");
  return dataField.type.typeIdx;
}

/**
 * Resolve a ts.Type to a ValType, using the struct registry and anonymous type map.
 * Use this instead of mapTsTypeToWasm in the codegen to get real type indices.
 */
export function resolveWasmType(ctx: CodegenContext, tsType: ts.Type): ValType {
  // Check Array<T> / T[] BEFORE isExternalDeclaredClass, because Array is declared
  // in the lib as `declare var Array: ArrayConstructor` which would match externref
  if (tsType.flags & ts.TypeFlags.Object) {
    const sym = (tsType as ts.TypeReference).symbol ?? (tsType as ts.Type).symbol;
    if (sym?.name === "Array") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      const elemTsType = typeArgs[0];
      const elemWasm: ValType = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "externref" };
      const elemKey = (elemWasm.kind === "ref" || elemWasm.kind === "ref_null")
        ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}` : elemWasm.kind;
      const vecIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
      // Use ref_null so locals can default-initialize to null
      return { kind: "ref_null", typeIdx: vecIdx };
    }

    // Check externref AFTER Array check — Array is declared in lib but should use wasm GC arrays
    if (isExternalDeclaredClass(tsType, ctx.checker)) return { kind: "externref" };

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
  if (isExternalDeclaredClass(tsType, ctx.checker)) return;

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
    // Top-level declare class (e.g. user-defined or import-resolver stubs)
    if (ts.isClassDeclaration(stmt) && stmt.name && hasDeclareModifier(stmt)) {
      collectExternClass(ctx, stmt, []);
    }
    // declare var X: { prototype: X; new(): X } (lib.dom.d.ts pattern)
    // declare var Date: DateConstructor (interface with new() pattern)
    if (ts.isVariableStatement(stmt) && hasDeclareModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.name || !ts.isIdentifier(decl.name) || !decl.type) continue;
        // Inline type literal with construct signature
        if (
          ts.isTypeLiteralNode(decl.type) &&
          decl.type.members.some((m) => ts.isConstructSignatureDeclaration(m))
        ) {
          collectExternFromDeclareVar(ctx, decl);
        }
        // Type reference to interface with construct signature (e.g. declare var Date: DateConstructor)
        // Skip types with built-in wasm handling (Array, primitives, etc.)
        else if (ts.isTypeReferenceNode(decl.type)) {
          const varName = decl.name.text;
          const BUILTIN_SKIP = new Set([
            "Array", "Number", "Boolean", "String", "Object", "Function",
            "Symbol", "BigInt", "Int8Array", "Uint8Array", "Int16Array",
            "Uint16Array", "Int32Array", "Uint32Array", "Float32Array",
            "Float64Array", "ArrayBuffer", "DataView", "JSON", "Math",
          ]);
          if (!BUILTIN_SKIP.has(varName)) {
            const refType = ctx.checker.getTypeAtLocation(decl.type);
            const constructSigs = refType.getConstructSignatures();
            if (constructSigs.length > 0) {
              collectExternFromDeclareVar(ctx, decl);
            }
          }
        }
      }
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
        let requiredParams = 1;
        for (const p of member.parameters) {
          const pt = ctx.checker.getTypeAtLocation(p);
          params.push(mapTsTypeToWasm(pt, ctx.checker));
          if (!p.questionToken && !p.initializer) requiredParams++;
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        const results: ValType[] = isVoidType(retType)
          ? []
          : [mapTsTypeToWasm(retType, ctx.checker)];
        info.methods.set(methodName, { params, results, requiredParams });
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

/** Collect extern class info from a `declare var X: { prototype: X; new(): X }` (lib.dom.d.ts pattern) */
function collectExternFromDeclareVar(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
): void {
  const className = (decl.name as ts.Identifier).text;
  if (ctx.externClasses.has(className)) return;

  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return;

  const info: ExternClassInfo = {
    importPrefix: className,
    namespacePath: [],
    className,
    constructorParams: [],
    methods: new Map(),
    properties: new Map(),
  };

  // Extract constructor params from the construct signature
  if (decl.type) {
    if (ts.isTypeLiteralNode(decl.type)) {
      for (const member of decl.type.members) {
        if (ts.isConstructSignatureDeclaration(member)) {
          for (const param of member.parameters) {
            const paramType = ctx.checker.getTypeAtLocation(param);
            info.constructorParams.push(mapTsTypeToWasm(paramType, ctx.checker));
          }
          break;
        }
      }
    } else if (ts.isTypeReferenceNode(decl.type)) {
      // Resolve interface reference (e.g. DateConstructor) to get construct signatures
      const refType = ctx.checker.getTypeAtLocation(decl.type);
      const constructSigs = refType.getConstructSignatures();
      // Use the zero-arg constructor if available, otherwise the first one
      const sig = constructSigs.find(s => s.parameters.length === 0) ?? constructSigs[0];
      if (sig) {
        for (const param of sig.parameters) {
          const paramType = ctx.checker.getTypeOfSymbol(param);
          info.constructorParams.push(mapTsTypeToWasm(paramType, ctx.checker));
        }
      }
    }
  }

  // Collect members from own interface declarations + non-extern mixin interfaces
  const allDecls = symbol.getDeclarations() ?? [];
  const visited = new Set<string>();
  for (const d of allDecls) {
    if (!ts.isInterfaceDeclaration(d)) continue;
    // Collect own members
    collectInterfaceMembers(ctx, d, info, decl);
    // Walk extends: first extern parent → inheritance chain, non-extern → collect their members
    if (d.heritageClauses) {
      let parentSet = false;
      for (const clause of d.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const typeRef of clause.types) {
          const baseType = ctx.checker.getTypeAtLocation(typeRef);
          const baseName = baseType.getSymbol()?.name;
          if (!baseName) continue;
          if (!parentSet && !ctx.externClassParent.has(className)) {
            // First extends type → record as parent for inheritance chain
            ctx.externClassParent.set(className, baseName);
            parentSet = true;
          }
          // If this base is NOT an extern class, it's a mixin — collect its members
          if (!isExternalDeclaredClass(baseType, ctx.checker)) {
            collectMixinMembers(ctx, baseType, info, decl, visited);
          }
        }
      }
    }
  }

  ctx.externClasses.set(className, info);
}

/** Collect methods and properties from an interface declaration */
function collectInterfaceMembers(
  ctx: CodegenContext,
  iface: ts.InterfaceDeclaration,
  info: ExternClassInfo,
  locationNode: ts.Node,
): void {
  for (const member of iface.members) {
    // Method signatures
    if (ts.isMethodSignature(member) && member.name && ts.isIdentifier(member.name)) {
      const methodName = member.name.text;
      if (info.methods.has(methodName)) continue;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      if (sig) {
        const params: ValType[] = [{ kind: "externref" }];
        let requiredParams = 1;
        for (const p of member.parameters) {
          const pt = ctx.checker.getTypeAtLocation(p);
          params.push(mapTsTypeToWasm(pt, ctx.checker));
          if (!p.questionToken) requiredParams++;
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        const results: ValType[] = isVoidType(retType)
          ? []
          : [mapTsTypeToWasm(retType, ctx.checker)];
        info.methods.set(methodName, { params, results, requiredParams });
      }
    }
    // Property signatures
    if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
      const isReadonly =
        member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
      info.properties.set(propName, { type: wasmType, readonly: isReadonly });
    }
    // Getter accessors (e.g. `get style(): CSSStyleDeclaration`)
    if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
      // Check if there's a matching setter
      const hasSetter = iface.members.some(
        (m) => ts.isSetAccessorDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === propName,
      );
      info.properties.set(propName, { type: wasmType, readonly: !hasSetter });
    }
  }
}

/** Recursively collect members from non-extern mixin interfaces */
function collectMixinMembers(
  ctx: CodegenContext,
  mixinType: ts.Type,
  info: ExternClassInfo,
  locationNode: ts.Node,
  visited: Set<string>,
): void {
  const mixinSymbol = mixinType.getSymbol();
  if (!mixinSymbol) return;
  const mixinName = mixinSymbol.name;
  if (visited.has(mixinName)) return;
  visited.add(mixinName);

  for (const d of mixinSymbol.getDeclarations() ?? []) {
    if (!ts.isInterfaceDeclaration(d)) continue;
    collectInterfaceMembers(ctx, d, info, locationNode);
    // Also walk this mixin's extends (for deeply nested mixins)
    if (d.heritageClauses) {
      for (const clause of d.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const typeRef of clause.types) {
          const baseType = ctx.checker.getTypeAtLocation(typeRef);
          if (!isExternalDeclaredClass(baseType, ctx.checker)) {
            collectMixinMembers(ctx, baseType, info, locationNode, visited);
          }
        }
      }
    }
  }
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

    // obj[idx] on externref (e.g. HTMLCollection) → __extern_get
    if (ts.isElementAccessExpression(node)) {
      const objType = ctx.checker.getTypeAtLocation(node.expression);
      const sym = objType.getSymbol();
      // Skip Array types — those use Wasm GC array.get, not host import
      if (sym?.name !== "Array") {
        const wasmType = mapTsTypeToWasm(objType, ctx.checker);
        if (wasmType.kind === "externref") {
          register("__extern_get", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
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
  libFile: ts.SourceFile,
  userFile: ts.SourceFile,
): void {
  // First collect identifiers referenced in user source
  const referencedNames = new Set<string>();
  const collectRefs = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) referencedNames.add(node.text);
    ts.forEachChild(node, collectRefs);
  };
  for (const stmt of userFile.statements) {
    ts.forEachChild(stmt, collectRefs);
  }

  for (const stmt of libFile.statements) {
    if (!ts.isVariableStatement(stmt) || !hasDeclareModifier(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (!referencedNames.has(name)) continue; // only register used globals
      if (ctx.declaredGlobals.has(name)) continue;
      const type = ctx.checker.getTypeAtLocation(decl);
      if (!isExternalDeclaredClass(type, ctx.checker)) continue;
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
const LIB_GLOBALS = new Set([
  "document", "window", "Date", "RegExp", "Error",
  "HTMLElement", "Element", "Node", "Event",
]);

function sourceUsesLibGlobals(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && LIB_GLOBALS.has(node.text)) {
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
/** Collect a local class declaration: register struct type, constructor, and methods */
function collectClassDeclaration(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration,
): void {
  const className = decl.name!.text;
  ctx.classSet.add(className);

  // Find the constructor to determine struct fields from `this.x = ...` assignments
  const ctor = decl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
  const fields: FieldDef[] = [];

  if (ctor?.body) {
    for (const stmt of ctor.body.statements) {
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(stmt.expression.left) &&
        stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const fieldName = stmt.expression.left.name.text;
        const fieldTsType = ctx.checker.getTypeAtLocation(stmt.expression.left);
        const fieldType = resolveWasmType(ctx, fieldTsType);
        if (!fields.some((f) => f.name === fieldName)) {
          fields.push({ name: fieldName, type: fieldType, mutable: true });
        }
      }
    }
  }

  // Also collect fields from property declarations (class Point { x: number; y: number; })
  for (const member of decl.members) {
    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const fieldName = member.name.text;
      if (!fields.some((f) => f.name === fieldName)) {
        const fieldTsType = ctx.checker.getTypeAtLocation(member);
        const fieldType = resolveWasmType(ctx, fieldTsType);
        fields.push({ name: fieldName, type: fieldType, mutable: true });
      }
    }
  }

  // Register the struct type
  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: className, fields } as StructTypeDef);
  ctx.structMap.set(className, structTypeIdx);
  ctx.structFields.set(className, fields);

  // Register constructor function: takes ctor params, returns (ref $structTypeIdx)
  const ctorParams: ValType[] = [];
  if (ctor) {
    for (const param of ctor.parameters) {
      const paramType = ctx.checker.getTypeAtLocation(param);
      ctorParams.push(resolveWasmType(ctx, paramType));
    }
  }
  const ctorResults: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
  const ctorTypeIdx = addFuncType(ctx, ctorParams, ctorResults, `${className}_new_type`);
  const ctorFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const ctorName = `${className}_new`;
  ctx.funcMap.set(ctorName, ctorFuncIdx);

  ctx.mod.functions.push({
    name: ctorName,
    typeIdx: ctorTypeIdx,
    locals: [],
    body: [],
    exported: false,
  });

  // Register method functions
  for (const member of decl.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const methodName = member.name.text;
      const fullName = `${className}_${methodName}`;
      ctx.classMethodSet.add(fullName);

      // First param is self: (ref $structTypeIdx)
      const methodParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        methodParams.push(resolveWasmType(ctx, paramType));
      }

      const sig = ctx.checker.getSignatureFromDeclaration(member);
      let methodResults: ValType[] = [];
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retType)) {
          methodResults = [resolveWasmType(ctx, retType)];
        }
      }

      const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);
      const methodFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(fullName, methodFuncIdx);

      ctx.mod.functions.push({
        name: fullName,
        typeIdx: methodTypeIdx,
        locals: [],
        body: [],
        exported: false,
      });
    }
  }
}

/**
 * For a generic function, find the first call site in the source and resolve
 * concrete param/return types from the checker's instantiated signature.
 * Returns null if no call site is found (function stays with erased types).
 */
function resolveGenericCallSiteTypes(
  ctx: CodegenContext,
  funcName: string,
  sourceFile: ts.SourceFile,
): { params: ValType[]; results: ValType[] } | null {
  let found: { params: ValType[]; results: ValType[] } | null = null;

  function visit(node: ts.Node) {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === funcName
    ) {
      const sig = ctx.checker.getResolvedSignature(node);
      if (sig) {
        const params: ValType[] = [];
        const sigParams = sig.getParameters();
        for (let i = 0; i < sigParams.length; i++) {
          const paramType = ctx.checker.getTypeOfSymbol(sigParams[i]!);
          params.push(resolveWasmType(ctx, paramType));
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        const results: ValType[] = isVoidType(retType)
          ? []
          : [resolveWasmType(ctx, retType)];
        found = { params, results };
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return found;
}

function collectDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  isEntryFile = true,
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

  // Collect class declarations (struct types + constructor/method functions)
  for (const stmt of sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name && !hasDeclareModifier(stmt)) {
      collectClassDeclaration(ctx, stmt);
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

      // Check if this is a generic function — resolve types from call site
      const isGeneric = stmt.typeParameters && stmt.typeParameters.length > 0;
      const resolved = isGeneric
        ? resolveGenericCallSiteTypes(ctx, name, sourceFile)
        : null;
      if (resolved) {
        ctx.genericResolved.set(name, resolved);
      }

      // Track async functions — unwrap Promise<T> for Wasm return type
      const isAsync = hasAsyncModifier(stmt);
      if (isAsync) {
        ctx.asyncFunctions.add(name);
      }

      // Ensure anonymous types in signature are registered as structs
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      // For async functions, unwrap Promise<T> to get T for struct registration
      const unwrappedRetType = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;
      if (!isVoidType(unwrappedRetType)) ensureStructForType(ctx, unwrappedRetType);
      for (const p of stmt.parameters) {
        const pt = ctx.checker.getTypeAtLocation(p);
        ensureStructForType(ctx, pt);
      }

      let params: ValType[];
      let results: ValType[];

      if (resolved) {
        // Use call-site resolved types for generic functions
        params = resolved.params;
        results = resolved.results;
      } else {
        params = [];
        for (let i = 0; i < stmt.parameters.length; i++) {
          const param = stmt.parameters[i]!;
          if (param.dotDotDotToken) {
            // Rest parameter: ...args: T[] → single (ref $__arr_elemKind) param
            const paramType = ctx.checker.getTypeAtLocation(param);
            const typeArgs = ctx.checker.getTypeArguments(paramType as ts.TypeReference);
            const elemTsType = typeArgs[0];
            const elemType: ValType = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
            // Use a unique key for ref element types so each struct gets its own array type
            const elemKey = (elemType.kind === "ref" || elemType.kind === "ref_null")
              ? `ref_${elemType.typeIdx}` : elemType.kind;
            const arrTypeIdx = getOrRegisterArrayType(ctx, elemKey, elemType);
            params.push({ kind: "ref_null", typeIdx: arrTypeIdx });
            ctx.funcRestParams.set(name, {
              restIndex: i,
              elemType,
              arrayTypeIdx: arrTypeIdx,
            });
          } else {
            const paramType = ctx.checker.getTypeAtLocation(param);
            const wasmType = resolveWasmType(ctx, paramType);
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
        if (param.questionToken) {
          optionalParams.push({ index: i, type: params[i]! });
        }
      }

      if (optionalParams.length > 0) {
        ctx.funcOptionalParams.set(name, optionalParams);
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
      }
    }
  }

  // Fourth: collect module-level variable declarations as wasm globals
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (hasDeclareModifier(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (ctx.funcMap.has(name)) continue; // skip if shadowed by function
      if (ctx.moduleGlobals.has(name)) continue; // skip if already registered

      const varType = ctx.checker.getTypeAtLocation(decl);
      const wasmType = resolveWasmType(ctx, varType);

      // Build null/zero initializer for the global
      const init: Instr[] = wasmType.kind === "f64"
        ? [{ op: "f64.const", value: 0 }]
        : wasmType.kind === "i32"
          ? [{ op: "i32.const", value: 0 }]
          : (wasmType.kind === "ref_null" || wasmType.kind === "ref")
            ? [{ op: "ref.null", typeIdx: (wasmType as { typeIdx: number }).typeIdx }]
            : [{ op: "ref.null.extern" }];

      // Widen non-nullable ref to ref_null so the global can hold null initially
      const globalType: ValType = wasmType.kind === "ref"
        ? { kind: "ref_null", typeIdx: (wasmType as { typeIdx: number }).typeIdx }
        : wasmType;

      const globalIdx = ctx.mod.globals.length;
      ctx.mod.globals.push({
        name: `__mod_${name}`,
        type: globalType,
        mutable: true,
        init,
      });
      ctx.moduleGlobals.set(name, globalIdx);
    }
    // Collect the statement for init compilation
    ctx.moduleInitStatements.push(stmt);
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

/** Compile all function bodies (including class constructors and methods) */
function compileDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  // Build a map from function name → index within ctx.mod.functions
  const funcByName = new Map<string, number>();
  for (let i = 0; i < ctx.mod.functions.length; i++) {
    funcByName.set(ctx.mod.functions[i]!.name, i);
  }

  // Compile class constructors and methods
  for (const stmt of sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name && !hasDeclareModifier(stmt)) {
      compileClassBodies(ctx, stmt, funcByName);
    }
  }

  // Compile top-level function declarations
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && !hasDeclareModifier(stmt)) {
      if (stmt.body) {
        const idx = funcByName.get(stmt.name.text);
        if (idx !== undefined) {
          const func = ctx.mod.functions[idx]!;
          compileFunctionBody(ctx, stmt, func);
        }
      }
    }
  }

  // Compile module-level init statements into the start of main()
  if (ctx.moduleInitStatements.length > 0) {
    const mainIdx = funcByName.get("main");
    if (mainIdx !== undefined) {
      const mainFunc = ctx.mod.functions[mainIdx]!;
      // Create a temporary FunctionContext for compiling init statements
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
      };
      ctx.currentFunc = initFctx;

      for (const stmt of ctx.moduleInitStatements) {
        compileStatement(ctx, initFctx, stmt);
      }

      ctx.currentFunc = null;

      // Prepend init body + init locals to main's body
      if (initFctx.body.length > 0) {
        mainFunc.body = [...initFctx.body, ...mainFunc.body];
        // Add init locals to main's locals (adjust any local indices in init body)
        // Find number of existing main locals
        const existingLocals = mainFunc.locals.length;
        // Append init locals to main's locals
        mainFunc.locals = [...mainFunc.locals, ...initFctx.locals];
        // Adjust local indices in init body (shift by existing locals count in main)
        if (existingLocals > 0) {
          for (const instr of initFctx.body) {
            if ((instr.op === "local.get" || instr.op === "local.set" || instr.op === "local.tee") && typeof (instr as any).index === "number") {
              (instr as any).index += existingLocals;
            }
          }
        }
      }
    }
  }
}

/** Compile constructor and method bodies for a class declaration */
function compileClassBodies(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration,
  funcByName: Map<string, number>,
): void {
  const className = decl.name!.text;
  const structTypeIdx = ctx.structMap.get(className)!;
  const fields = ctx.structFields.get(className)!;

  // Compile constructor
  const ctor = decl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
  const ctorName = `${className}_new`;
  const ctorLocalIdx = funcByName.get(ctorName);
  if (ctorLocalIdx !== undefined) {
    const func = ctx.mod.functions[ctorLocalIdx]!;
    const params: { name: string; type: ValType }[] = [];
    if (ctor) {
      for (const param of ctor.parameters) {
        const paramName = (param.name as ts.Identifier).text;
        const paramType = ctx.checker.getTypeAtLocation(param);
        params.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
      }
    }

    const fctx: FunctionContext = {
      name: ctorName,
      params,
      locals: [],
      localMap: new Map(),
      returnType: { kind: "ref", typeIdx: structTypeIdx },
      body: [],
      blockDepth: 0,
      breakStack: [],
      continueStack: [],
    };

    for (let i = 0; i < params.length; i++) {
      fctx.localMap.set(params[i]!.name, i);
    }

    // Allocate a local for the struct instance
    const selfLocal = allocLocal(fctx, "__self", { kind: "ref", typeIdx: structTypeIdx });

    // Push default values for all fields, then struct.new
    for (const field of fields) {
      if (field.type.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (field.type.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (field.type.kind === "externref") {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (field.type.kind === "ref" || field.type.kind === "ref_null") {
        fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
      }
    }
    fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
    fctx.body.push({ op: "local.set", index: selfLocal });

    // Compile constructor body — `this` maps to __self local
    fctx.localMap.set("this", selfLocal);
    ctx.currentFunc = fctx;

    if (ctor?.body) {
      for (const stmt of ctor.body.statements) {
        compileStatement(ctx, fctx, stmt);
      }
    }

    // Return the struct instance
    fctx.body.push({ op: "local.get", index: selfLocal });

    func.locals = fctx.locals;
    func.body = fctx.body;
    ctx.currentFunc = null;
  }

  // Compile methods
  for (const member of decl.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const methodName = member.name.text;
      const fullName = `${className}_${methodName}`;
      const methodLocalIdx = funcByName.get(fullName);
      if (methodLocalIdx === undefined) continue;

      const func = ctx.mod.functions[methodLocalIdx]!;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;

      // First param is self
      const params: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (const param of member.parameters) {
        const paramName = (param.name as ts.Identifier).text;
        const paramType = ctx.checker.getTypeAtLocation(param);
        params.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
      }

      const fctx: FunctionContext = {
        name: fullName,
        params,
        locals: [],
        localMap: new Map(),
        returnType: retType && !isVoidType(retType) ? resolveWasmType(ctx, retType) : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
      };

      for (let i = 0; i < params.length; i++) {
        fctx.localMap.set(params[i]!.name, i);
      }

      ctx.currentFunc = fctx;

      if (member.body) {
        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }
      }

      // Ensure valid return for non-void methods
      if (fctx.returnType) {
        const lastInstr = fctx.body[fctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
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
  }
}

function compileFunctionBody(
  ctx: CodegenContext,
  decl: ts.FunctionDeclaration,
  func: WasmFunction,
): void {
  const sig = ctx.checker.getSignatureFromDeclaration(decl)!;
  const retType = ctx.checker.getReturnTypeOfSignature(sig);

  // For async functions, unwrap Promise<T> to get T
  const isAsync = ctx.asyncFunctions.has(func.name);
  const effectiveRetType = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;

  // Use call-site resolved types for generic functions
  const resolved = ctx.genericResolved.get(func.name);

  const restInfo = ctx.funcRestParams.get(func.name);
  const params: { name: string; type: ValType }[] = [];
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    const paramName = (param.name as ts.Identifier).text;
    if (restInfo && i === restInfo.restIndex) {
      // Rest parameter — use the array ref type from the function signature
      params.push({ name: paramName, type: { kind: "ref_null", typeIdx: restInfo.arrayTypeIdx } });
    } else {
      const paramType = resolved
        ? resolved.params[i]!
        : resolveWasmType(ctx, ctx.checker.getTypeAtLocation(param));
      params.push({ name: paramName, type: paramType });
    }
  }

  const returnType = resolved
    ? (resolved.results.length > 0 ? resolved.results[0]! : null)
    : (isVoidType(effectiveRetType) ? null : resolveWasmType(ctx, effectiveRetType));

  const fctx: FunctionContext = {
    name: func.name,
    params,
    locals: [],
    localMap: new Map(),
    returnType,
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

function hasAsyncModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
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
