import ts from "typescript";
import type { MultiTypedAST, TypedAST } from "../checker/index.js";
import { eliminateDeadImports } from "./dead-elimination.js";
import {
  isBooleanType,
  isExternalDeclaredClass,
  isHeterogeneousUnion,
  isNumberType,
  isStringType,
  isVoidType,
  mapTsTypeToWasm,
  unwrapPromiseType,
} from "../checker/type-mapper.js";
import type {
  ArrayTypeDef,
  FieldDef,
  FuncTypeDef,
  Import,
  Instr,
  LocalDef,
  SourcePos,
  StructTypeDef,
  TagDef,
  ValType,
  WasmFunction,
  WasmModule,
} from "../ir/types.js";
import { createEmptyModule } from "../ir/types.js";
import { compileExpression, resolveComputedKeyExpression } from "./expressions.js";
import { collectShapes } from "../shape-inference.js";
import { compileStatement, hoistFunctionDeclarations } from "./statements.js";
import { emitInlineMathFunctions } from "./math-helpers.js";

/** Result returned by generateModule / generateMultiModule */
export interface CodegenResult {
  module: WasmModule;
  errors: { message: string; line: number; column: number }[];
}

/**
 * Report a codegen error with source location extracted from an AST node.
 * Pushes the error into ctx.errors so it can be propagated to the caller.
 */
export function reportError(
  ctx: CodegenContext,
  node: ts.Node,
  message: string,
): void {
  try {
    const sf = node.getSourceFile();
    if (sf) {
      const { line, character } = sf.getLineAndCharacterOfPosition(
        node.getStart(),
      );
      ctx.errors.push({ message, line: line + 1, column: character + 1 });
    } else {
      ctx.errors.push({ message, line: 0, column: 0 });
    }
  } catch {
    ctx.errors.push({ message, line: 0, column: 0 });
  }
}

/** Info about an externally declared class */
export interface ExternClassInfo {
  importPrefix: string;
  namespacePath: string[];
  className: string;
  constructorParams: ValType[];
  methods: Map<
    string,
    { params: ValType[]; results: ValType[]; requiredParams: number }
  >;
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
  /** Vec struct type index wrapping the array */
  vecTypeIdx: number;
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
  /** Map from string literal value → import func name (legacy, unused with importedStringConstants) */
  stringLiteralMap: Map<string, string>;
  /** Map from import name → string literal value (for .d.ts comments) */
  stringLiteralValues: Map<string, string>;
  /** Counter for string literal imports */
  stringLiteralCounter: number;
  /** Map from string literal value → global import index (for importedStringConstants) */
  stringGlobalMap: Map<string, number>;
  /** Number of imported globals (string constants) — offsets module-defined global indices */
  numImportGlobals: number;
  /** Whether wasm:js-string imports have been registered */
  hasStringImports: boolean;
  /** Map from "EnumName.Member" → numeric value */
  enumValues: Map<string, number>;
  /** Map from "EnumName.Member" → string value (for string enums) */
  enumStringValues: Map<string, string>;
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
  /** Set of "ClassName_propName" for getter/setter accessor properties */
  classAccessorSet: Set<string>;
  /** Set of "ClassName_methodName" for static methods (no self param) */
  staticMethodSet: Set<string>;
  /** Map from "ClassName_propName" → global index for static properties */
  staticProps: Map<string, number>;
  /** Static property initializer expressions to compile into __module_init */
  staticInitExprs: { globalIdx: number; initializer: ts.Expression }[];
  /** Counter for generated closure types/functions */
  closureCounter: number;
  /** Map from local variable name → closure metadata (for call_ref dispatch) */
  closureMap: Map<string, ClosureInfo>;
  /** Map from closure struct type index → closure metadata (for anonymous closures) */
  closureInfoByTypeIdx: Map<number, ClosureInfo>;
  /** Resolved concrete types for generic functions (from call-site analysis) */
  genericResolved: Map<string, { params: ValType[]; results: ValType[] }>;
  /** Rest parameter info per function (functions with ...rest syntax) */
  funcRestParams: Map<string, RestParamInfo>;
  /** Map from struct name → set of closure type indices used for valueOf fields */
  valueOfClosureTypes: Map<string, number[]>;
  /** Tag index for the exception tag (-1 if not yet registered) */
  exnTagIdx: number;
  /** Whether union type helper imports have been registered */
  hasUnionImports: boolean;
  /** Set of function names that are async (for .d.ts generation) */
  asyncFunctions: Set<string>;
  /** Set of function names that are generators (function*) */
  generatorFunctions: Set<string>;
  /** Map from generator function name → yield element type (wasm ValType kind for the yielded values) */
  generatorYieldType: Map<string, ValType>;
  /** Map from module-level variable name → global index in mod.globals */
  moduleGlobals: Map<string, number>;
  /** Module-level variable initializers (compiled into __module_init) */
  moduleInitStatements: ts.Statement[];
  /** Nested function capture info: funcName → list of captures with outer local indices */
  nestedFuncCaptures: Map<string, { name: string; outerLocalIdx: number; mutable?: boolean; valType?: ValType }[]>;
  /** Map from child className → parent className (for local class inheritance) */
  classParentMap: Map<string, string>;
  /** Counter for assigning unique class tags (for instanceof support) */
  classTagCounter: number;
  /** Map from class name → unique tag value (for instanceof support) */
  classTagMap: Map<string, number>;
  /** Map from TS symbol name (e.g. "__class") → synthetic class name for class expressions */
  classExprNameMap: Map<string, string>;
  /** Map from ClassExpression AST node → synthetic class name for anonymous class in new expressions */
  anonClassExprNames: Map<ts.ClassExpression, string>;
  /** Whether to attach source positions for source map generation */
  sourceMap: boolean;
  /** Map from tuple type signature key → type index of the tuple struct */
  tupleTypeMap: Map<string, number>;
  /** Fast mode: default number to i32, promote to f64 only when needed */
  fast: boolean;
  /** Native string support (fast mode): type index for $__str_data (array (mut i16)) */
  nativeStrDataTypeIdx: number;
  /** Type index for $AnyString (struct { len: i32 }) — base type for rope subtyping */
  anyStrTypeIdx: number;
  /** Native string support (fast mode): type index for $NativeString (struct { len: i32, off: i32, data: ref $__str_data }) */
  nativeStrTypeIdx: number;
  /** Type index for $ConsString (struct { len: i32, left: ref $AnyString, right: ref $AnyString }) */
  consStrTypeIdx: number;
  /** Whether native string helper functions have been emitted */
  nativeStrHelpersEmitted: boolean;
  /** Map from native string helper name → function index */
  nativeStrHelpers: Map<string, number>;
  /** Map from value type kind → ref cell struct type index (for mutable closure captures) */
  refCellTypeMap: Map<string, number>;
  /** Type index of the $AnyValue boxed-any struct (-1 if not registered) */
  anyValueTypeIdx: number;
  /** Map from any-value helper name → function index */
  anyHelpers: Map<string, number>;
  /** Whether any-value helper functions have been emitted */
  anyHelpersEmitted: boolean;
  /** Shape-inferred array-like variables: varName → { vecTypeIdx, arrTypeIdx, elemType } */
  shapeMap: Map<string, { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType }>;
  /** Set of function names that failed during hoisting pre-pass (to avoid re-emitting errors) */
  hoistFailedFuncs?: Set<string>;
  /** Counter for unique tagged template cache global variables */
  templateCacheCounter: number;
  /** Type index for template vec struct (vec + raw field), -1 if not yet registered */
  templateVecTypeIdx: number;
  /** Extra properties for empty object variables (varName -> props to add) */
  widenedTypeProperties: Map<string, { name: string; type: ValType }[]>;
  /** Map from widened variable name to its registered struct name */
  widenedVarStructMap: Map<string, string>;
  /** Math methods that need inline Wasm implementations (filled by collectMathImports, consumed by emitInlineMathFunctions) */
  pendingMathMethods: Set<string>;
  /** Map from class name → class AST declaration node (for inherited field initializers) */
  classDeclarationMap: Map<string, ts.ClassDeclaration | ts.ClassExpression>;
  /** Type index for $WrapperNumber struct (-1 if not registered) */
  wrapperNumberTypeIdx: number;
  /** Type index for $WrapperString struct (-1 if not registered) */
  wrapperStringTypeIdx: number;
  /** Type index for $WrapperBoolean struct (-1 if not registered) */
  wrapperBooleanTypeIdx: number;
  /** Cache for function reference wrappers: signature key → ClosureInfo */
  funcRefWrapperCache: Map<string, ClosureInfo>;
  /** Pending module-init body (not yet in mod.functions) that needs global index fixup */
  pendingInitBody: Instr[] | null;
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
  /** Map from label name to break/continue stack indices for labeled break/continue */
  labelMap: Map<string, { breakIdx: number; continueIdx: number }>;
  /** Depth for `return` inside generator body -- adjusted by loop/block nesting */
  generatorReturnDepth?: number;
  /** Map from variable name → ref cell info (for mutable closure captures) */
  boxedCaptures?: Map<string, { refCellTypeIdx: number; valType: ValType }>;
  /** Whether this function is a class constructor (for new.target support) */
  isConstructor?: boolean;
  /** Set of variable names that are read-only bindings (e.g. named function expression name) */
  readOnlyBindings?: Set<string>;
  /** Stack of saved body arrays for addUnionImports index shifting */
  savedBodies: Instr[][];
}

/**
 * Swap fctx.body to a fresh array, pushing the current body onto the
 * savedBodies stack so that addUnionImports (and any other late import
 * addition) can shift function indices in the saved body too.
 * Returns the saved body reference for later restoration via popBody().
 */
export function pushBody(fctx: FunctionContext): Instr[] {
  const saved = fctx.body;
  fctx.savedBodies.push(saved);
  fctx.body = [];
  return saved;
}

/**
 * Restore fctx.body from a previously-saved reference, popping the
 * savedBodies stack.
 */
export function popBody(fctx: FunctionContext, saved: Instr[]): void {
  fctx.savedBodies.pop();
  fctx.body = saved;
}

/** Options for code generation */
export interface CodegenResult {
  module: WasmModule;
  errors: { message: string; line: number; column: number }[];
}

export interface CodegenOptions {
  /** Whether to generate source positions for source map */
  sourceMap?: boolean;
  /** Fast mode: i32 default numbers */
  fast?: boolean;
}

/** Compile a typed AST into a WasmModule IR */
export function generateModule(
  ast: TypedAST,
  options?: CodegenOptions,
): {
  module: WasmModule;
  errors: { message: string; line: number; column: number }[];
} {
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
    stringGlobalMap: new Map(),
    numImportGlobals: 0,
    hasStringImports: false,
    enumValues: new Map(),
    enumStringValues: new Map(),
    arrayTypeMap: new Map(),
    vecTypeMap: new Map(),
    externClassParent: new Map(),
    declaredGlobals: new Map(),
    callbackCounter: 0,
    capturedGlobals: new Map(),
    capturedGlobalsWidened: new Set(),
    classSet: new Set(),
    classMethodSet: new Set(),
    classAccessorSet: new Set(),
    staticMethodSet: new Set(),
    staticProps: new Map(),
    staticInitExprs: [],
    closureCounter: 0,
    closureMap: new Map(),
    closureInfoByTypeIdx: new Map(),
    genericResolved: new Map(),
    funcRestParams: new Map(),
    valueOfClosureTypes: new Map(),
    exnTagIdx: -1,
    hasUnionImports: false,
    asyncFunctions: new Set(),
    generatorFunctions: new Set(),
    generatorYieldType: new Map(),
    moduleGlobals: new Map(),
    moduleInitStatements: [],
    nestedFuncCaptures: new Map(),
    classParentMap: new Map(),
    classTagCounter: 0,
    classTagMap: new Map(),
    classExprNameMap: new Map(),
    anonClassExprNames: new Map(),
    sourceMap: options?.sourceMap ?? false,
    tupleTypeMap: new Map(),
    fast: options?.fast ?? false,
    nativeStrDataTypeIdx: -1,
    anyStrTypeIdx: -1,
    nativeStrTypeIdx: -1,
    consStrTypeIdx: -1,
    nativeStrHelpersEmitted: false,
    nativeStrHelpers: new Map(),
    refCellTypeMap: new Map(),
    anyValueTypeIdx: -1,
    anyHelpers: new Map(),
    anyHelpersEmitted: false,
    shapeMap: new Map(),
    templateCacheCounter: 0,
    templateVecTypeIdx: -1,
    widenedTypeProperties: new Map(),
    widenedVarStructMap: new Map(),
    pendingMathMethods: new Set(),
    classDeclarationMap: new Map(),
    wrapperNumberTypeIdx: -1,
    wrapperStringTypeIdx: -1,
    wrapperBooleanTypeIdx: -1,
    funcRefWrapperCache: new Map(),
    pendingInitBody: null,
  };

  // Register native string types if fast mode
  if (ctx.fast) {
    registerNativeStringTypes(ctx);
  }

  // $AnyValue struct type is now registered lazily via ensureAnyValueType()

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

  // Pre-pass: detect empty object literals that get properties assigned later
  // Must run before import collectors so that widened types are known
  collectEmptyObjectWidening(ctx, ast.checker, ast.sourceFile);

  // Register only the extern class imports actually used in source code
  collectUsedExternImports(ctx, ast.sourceFile);

  // Collect string literals and register imports (must be before local func indices)
  collectStringLiterals(ctx, ast.sourceFile);

  // Collect string method imports (.toUpperCase(), .indexOf(), etc.)
  collectStringMethodImports(ctx, ast.sourceFile);

  // Collect Math host imports for methods without native Wasm equivalents
  collectMathImports(ctx, ast.sourceFile);

  // Collect parseInt / parseFloat host imports
  collectParseImports(ctx, ast.sourceFile);

  // Collect String.fromCharCode host imports
  collectStringStaticImports(ctx, ast.sourceFile);

  // Collect Promise.all / Promise.race host imports
  collectPromiseImports(ctx, ast.sourceFile);
  // Collect JSON.parse / JSON.stringify host imports
  collectJsonImports(ctx, ast.sourceFile);

  // Collect __make_callback import if arrow functions are used as call arguments
  collectCallbackImports(ctx, ast.sourceFile);

  // Collect host callback bridges for functional array methods (filter, map, etc.)
  collectFunctionalArrayImports(ctx, ast.sourceFile);

  // Collect union type helper imports (typeof checks, boxing/unboxing).
  // Always register union imports eagerly to avoid late-addition index shifting
  // that can corrupt savedBody instruction arrays (see #153). The pre-scan
  // collectUnionImports catches many cases but misses some (e.g. coercion inside
  // for-of loop bodies), so we unconditionally add them here.
  addUnionImports(ctx);

  // Collect generator imports (function* support)
  collectGeneratorImports(ctx, ast.sourceFile);
  // Collect iterator protocol imports for for...of on non-array types (strings, etc.)
  collectIteratorImports(ctx, ast.sourceFile);

  // Register string literals for for-in field names (uses type checker, before func indices)
  collectForInStringLiterals(ctx, ast.sourceFile);

  // Register string literals for dynamic `in` operator field names
  collectInExprStringLiterals(ctx, ast.sourceFile);

  // Register string literals for Object.keys() / Object.values() calls
  collectObjectMethodStringLiterals(ctx, ast.sourceFile);

  // Collect wrapper constructor usage (new Number/String/Boolean)
  collectWrapperConstructors(ctx, ast.sourceFile);

  // Collect unknown constructor imports (__new_X for `new X(...)` where X is not a known class)
  collectUnknownConstructorImports(ctx, ast.sourceFile);

  // Emit inline Wasm implementations for Math methods (after all imports are registered)
  if (ctx.pendingMathMethods.size > 0) {
    emitInlineMathFunctions(ctx, ctx.pendingMathMethods);
  }

  // Emit wrapper valueOf functions (after all imports registered, before user funcs)
  emitWrapperValueOfFunctions(ctx);

  // Second pass: collect all function declarations and interfaces
  collectDeclarations(ctx, ast.sourceFile);

  // Shape inference: detect array-like variables and override their types
  applyShapeInference(ctx, ast.checker, ast.sourceFile);

  // Third pass: compile function bodies
  compileDeclarations(ctx, ast.sourceFile);

  // Collect ref.func targets so the binary emitter can add a declarative element segment
  collectDeclaredFuncRefs(ctx);

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

  // Dead import and type elimination pass
  eliminateDeadImports(mod);

  return { module: mod, errors: ctx.errors };
}

/**
 * Compile multiple typed source files into a single WasmModule IR.
 * All source files share the same codegen context (funcMap, structMap, etc.).
 * Only functions exported from the entry file become Wasm exports.
 */
export function generateMultiModule(
  multiAst: MultiTypedAST,
  options?: CodegenOptions,
): {
  module: WasmModule;
  errors: { message: string; line: number; column: number }[];
} {
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
    stringGlobalMap: new Map(),
    numImportGlobals: 0,
    hasStringImports: false,
    enumValues: new Map(),
    enumStringValues: new Map(),
    arrayTypeMap: new Map(),
    vecTypeMap: new Map(),
    externClassParent: new Map(),
    declaredGlobals: new Map(),
    callbackCounter: 0,
    capturedGlobals: new Map(),
    capturedGlobalsWidened: new Set(),
    classSet: new Set(),
    classMethodSet: new Set(),
    classAccessorSet: new Set(),
    staticMethodSet: new Set(),
    staticProps: new Map(),
    staticInitExprs: [],
    closureCounter: 0,
    closureMap: new Map(),
    closureInfoByTypeIdx: new Map(),
    genericResolved: new Map(),
    funcRestParams: new Map(),
    valueOfClosureTypes: new Map(),
    hasUnionImports: false,
    asyncFunctions: new Set(),
    generatorFunctions: new Set(),
    generatorYieldType: new Map(),
    exnTagIdx: -1,
    moduleGlobals: new Map(),
    moduleInitStatements: [],
    nestedFuncCaptures: new Map(),
    classParentMap: new Map(),
    classTagCounter: 0,
    classTagMap: new Map(),
    classExprNameMap: new Map(),
    anonClassExprNames: new Map(),
    sourceMap: options?.sourceMap ?? false,
    tupleTypeMap: new Map(),
    fast: options?.fast ?? false,
    nativeStrDataTypeIdx: -1,
    anyStrTypeIdx: -1,
    nativeStrTypeIdx: -1,
    consStrTypeIdx: -1,
    nativeStrHelpersEmitted: false,
    nativeStrHelpers: new Map(),
    refCellTypeMap: new Map(),
    anyValueTypeIdx: -1,
    anyHelpers: new Map(),
    anyHelpersEmitted: false,
    shapeMap: new Map(),
    templateCacheCounter: 0,
    templateVecTypeIdx: -1,
    widenedTypeProperties: new Map(),
    widenedVarStructMap: new Map(),
    pendingMathMethods: new Set(),
    classDeclarationMap: new Map(),
    wrapperNumberTypeIdx: -1,
    wrapperStringTypeIdx: -1,
    wrapperBooleanTypeIdx: -1,
    funcRefWrapperCache: new Map(),
    pendingInitBody: null,
  };

  // Register native string types if fast mode
  if (ctx.fast) {
    registerNativeStringTypes(ctx);
  }

  // $AnyValue struct type is now registered lazily via ensureAnyValueType()

  // Phase 1: Collect all import-phase declarations across all source files
  for (const sf of multiAst.sourceFiles) {
    collectConsoleImports(ctx, sf);
    collectPrimitiveMethodImports(ctx, sf);
    collectExternDeclarations(ctx, sf);
  }

  // Scan lib.d.ts for DOM extern classes + globals (only if any user code uses DOM)
  const libFile = multiAst.program.getSourceFile("lib.d.ts");
  if (libFile) {
    const anyUsesDom = multiAst.sourceFiles.some((sf) =>
      sourceUsesLibGlobals(sf),
    );
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
    collectParseImports(ctx, sf);
    collectStringStaticImports(ctx, sf);
    collectPromiseImports(ctx, sf);
    collectJsonImports(ctx, sf);
    collectCallbackImports(ctx, sf);
    collectFunctionalArrayImports(ctx, sf);
    collectUnionImports(ctx, sf);
    collectGeneratorImports(ctx, sf);
    collectIteratorImports(ctx, sf);
    collectForInStringLiterals(ctx, sf);
    collectInExprStringLiterals(ctx, sf);
    collectObjectMethodStringLiterals(ctx, sf);
    collectWrapperConstructors(ctx, sf);
    collectUnknownConstructorImports(ctx, sf);
  }

  // Emit inline Wasm implementations for Math methods (after all imports are registered)
  if (ctx.pendingMathMethods.size > 0) {
    emitInlineMathFunctions(ctx, ctx.pendingMathMethods);
  }

  // Emit wrapper valueOf functions (after all imports registered, before user funcs)
  emitWrapperValueOfFunctions(ctx);

  // Phase 2: Collect all declarations — only entry file gets Wasm exports
  for (const sf of multiAst.sourceFiles) {
    const isEntry = sf === multiAst.entryFile;
    collectDeclarations(ctx, sf, isEntry);
  }

  // Shape inference: detect array-like variables and override their types
  for (const sf of multiAst.sourceFiles) {
    applyShapeInference(ctx, multiAst.checker, sf);
  }

  // Phase 3: Compile all function bodies
  for (const sf of multiAst.sourceFiles) {
    compileDeclarations(ctx, sf);
  }

  // Collect ref.func targets so the binary emitter can add a declarative element segment
  collectDeclaredFuncRefs(ctx);

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

  // Dead import and type elimination pass
  eliminateDeadImports(mod);

  return { module: mod, errors: ctx.errors };
}

/** Scan source for console.log/warn/error() calls and register only needed import variants */
function collectConsoleImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const CONSOLE_METHODS = ["log", "warn", "error"] as const;
  // Track needed variants per console method
  const neededByMethod = new Map<string, Set<"number" | "bool" | "string" | "externref">>();

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    ) {
      const method = node.expression.name.text;
      if (CONSOLE_METHODS.includes(method as any)) {
        if (!neededByMethod.has(method)) neededByMethod.set(method, new Set());
        const needed = neededByMethod.get(method)!;
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
    ts.forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  ts.forEachChild(sourceFile, visit);

  for (const method of CONSOLE_METHODS) {
    const needed = neededByMethod.get(method);
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
      addImport(ctx, "env", `console_${method}_externref`, {
        kind: "func",
        typeIdx: t,
      });
    }
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
    // String(expr) calls need number_toString for number→string coercion
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "String" &&
      node.arguments.length >= 1
    ) {
      const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      if (isNumberType(argType) || !isStringType(argType)) {
        needed.add("number_toString");
      }
    }
    // String + non-string concatenation needs number_toString for coercion.
    // Conservative: register whenever either side of + is a string and the
    // other is not (could be number, any, boolean — all may produce f64 at wasm level).
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
       node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      const leftType = ctx.checker.getTypeAtLocation(node.left);
      const rightType = ctx.checker.getTypeAtLocation(node.right);
      if (isStringType(leftType) && !isStringType(rightType)) {
        needed.add("number_toString");
      }
      if (!isStringType(leftType) && isStringType(rightType)) {
        needed.add("number_toString");
      }
      // For `any`-typed variables (e.g. `var __str; __str=""`), the left type
      // won't be detected as string, but at runtime it may hold a string.
      // When += is used with an `any`-typed LHS and a non-string RHS,
      // register number_toString so the coercion is available at codegen time.
      if (
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
        (leftType.flags & ts.TypeFlags.Any) !== 0 &&
        !isStringType(rightType)
      ) {
        needed.add("number_toString");
      }
    }
    // String comparison operators (< > <= >=) on string types need string_compare import
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
       node.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken ||
       node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
       node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken)
    ) {
      const leftType = ctx.checker.getTypeAtLocation(node.left);
      if (isStringType(leftType)) {
        needed.add("string_compare");
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  if (needed.has("number_toString")) {
    const t = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toString", { kind: "func", typeIdx: t });
  }
  if (needed.has("number_toFixed")) {
    const t = addFuncType(
      ctx,
      [{ kind: "f64" }, { kind: "f64" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "number_toFixed", { kind: "func", typeIdx: t });
  }
  if (needed.has("string_compare")) {
    const t = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    addImport(ctx, "env", "string_compare", { kind: "func", typeIdx: t });
  }
}

// String method signatures: name → { params (excluding self), resultKind }
const STRING_METHODS: Record<string, { params: ValType[]; result: ValType }> = {
  toUpperCase: { params: [], result: { kind: "externref" } },
  toLowerCase: { params: [], result: { kind: "externref" } },
  trim: { params: [], result: { kind: "externref" } },
  trimStart: { params: [], result: { kind: "externref" } },
  trimEnd: { params: [], result: { kind: "externref" } },
  charAt: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  slice: {
    params: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "externref" },
  },
  substring: {
    params: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "externref" },
  },
  indexOf: { params: [{ kind: "externref" }, { kind: "externref" }], result: { kind: "f64" } },
  lastIndexOf: { params: [{ kind: "externref" }, { kind: "externref" }], result: { kind: "f64" } },
  includes: { params: [{ kind: "externref" }], result: { kind: "i32" } },
  startsWith: { params: [{ kind: "externref" }], result: { kind: "i32" } },
  endsWith: { params: [{ kind: "externref" }], result: { kind: "i32" } },
  replace: {
    params: [{ kind: "externref" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  replaceAll: {
    params: [{ kind: "externref" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  repeat: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  padStart: {
    params: [{ kind: "f64" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  padEnd: {
    params: [{ kind: "f64" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  split: { params: [{ kind: "externref" }], result: { kind: "externref" } },
  at: { params: [{ kind: "f64" }], result: { kind: "externref" } },
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
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  // Native string methods handled in wasm (fast mode)
  const NATIVE_STR_METHODS = new Set([
    "charAt", "substring", "slice", "at",
    "indexOf", "lastIndexOf", "includes", "startsWith", "endsWith",
    "trim", "trimStart", "trimEnd",
    "repeat", "padStart", "padEnd", "toLowerCase", "toUpperCase",
    "replace", "replaceAll", "split",
  ]);

  for (const method of needed) {
    if (ctx.fast && NATIVE_STR_METHODS.has(method)) {
      // These are handled by native string helpers — no import needed
      ensureNativeStringHelpers(ctx);
      continue;
    }
    const sig = STRING_METHODS[method]!;
    const params: ValType[] = [{ kind: "externref" }, ...sig.params]; // self + args
    const t = addFuncType(ctx, params, [sig.result]);
    addImport(ctx, "env", `string_${method}`, { kind: "func", typeIdx: t });
  }

  // split() returns an externref JS array — register __extern_get and __extern_length
  // so that element access and .length work on the result.
  // In fast mode, native split returns a native string array — no extern helpers needed.
  if (needed.has("split") && !ctx.fast) {
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

/** Register wasm:js-string builtin imports (called on demand when strings are used) */
export function addStringImports(ctx: CodegenContext): void {
  if (ctx.hasStringImports) return;
  ctx.hasStringImports = true;

  // Record import count before adding so we can shift function indices
  // if this is called after collectDeclarations has run.
  const importsBefore = ctx.numImportFuncs;

  // concat: (externref, externref) -> (ref extern)
  const concatType = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "ref_extern" }],
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

  // substring: (externref, i32, i32) -> (ref extern)
  const substringType = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "ref_extern" }],
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

  // If imports were added after defined functions were registered (late addition),
  // shift all defined-function indices.
  const delta = ctx.numImportFuncs - importsBefore;
  if (delta > 0 && ctx.mod.functions.length > 0) {
    const newImportNames = new Set([
      "concat", "length", "equals", "substring", "charCodeAt",
    ]);
    for (const [name, idx] of ctx.funcMap) {
      if (!newImportNames.has(name) && idx >= importsBefore) {
        ctx.funcMap.set(name, idx + delta);
      }
    }
    for (const exp of ctx.mod.exports) {
      if (exp.desc.kind === "func" && exp.desc.index >= importsBefore) {
        exp.desc.index += delta;
      }
    }
    function shiftFuncIndices(instrs: Instr[]): void {
      for (const instr of instrs) {
        if (instr.op === "call" && instr.funcIdx >= importsBefore) {
          instr.funcIdx += delta;
        }
        if (instr.op === "ref.func" && instr.funcIdx >= importsBefore) {
          instr.funcIdx += delta;
        }
        if ("body" in instr && Array.isArray((instr as any).body)) {
          shiftFuncIndices((instr as any).body);
        }
        if ("then" in instr && Array.isArray((instr as any).then)) {
          shiftFuncIndices((instr as any).then);
        }
        if ("else" in instr && Array.isArray((instr as any).else)) {
          shiftFuncIndices((instr as any).else);
        }
        if ("catches" in instr && Array.isArray((instr as any).catches)) {
          for (const c of (instr as any).catches) {
            if (Array.isArray(c.body)) shiftFuncIndices(c.body);
          }
        }
        if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
          shiftFuncIndices((instr as any).catchAll);
        }
      }
    }
    for (const func of ctx.mod.functions) {
      shiftFuncIndices(func.body);
    }
    if (ctx.currentFunc) {
      const curBody = ctx.currentFunc.body;
      const alreadyShifted = ctx.mod.functions.some(f => f.body === curBody);
      if (!alreadyShifted) {
        shiftFuncIndices(curBody);
      }
    }
    for (const elem of ctx.mod.elements) {
      if (elem.funcIndices) {
        for (let i = 0; i < elem.funcIndices.length; i++) {
          if (elem.funcIndices[i]! >= importsBefore) {
            elem.funcIndices[i]! += delta;
          }
        }
      }
    }
    if (ctx.mod.declaredFuncRefs.length > 0) {
      ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map(
        idx => idx >= importsBefore ? idx + delta : idx,
      );
    }
  }
}

// ── Native string support (fast mode) ────────────────────────────────

/**
 * Register the WasmGC types for native strings (rope/cons-string support):
 *   $__str_data   = (array (mut i16))
 *   $AnyString    = (sub (struct (field $len i32)))                                   -- non-final base
 *   $NativeString = (sub $AnyString (struct (field $len i32) (field $off i32) (field $data (ref $__str_data))))
 *   $ConsString   = (sub $AnyString (struct (field $len i32) (field $left (ref $AnyString)) (field $right (ref $AnyString))))
 *
 * Field layout: len is always field 0 (shared via AnyString prefix).
 * NativeString: field 0 = len, field 1 = off, field 2 = data
 * ConsString:   field 0 = len, field 1 = left, field 2 = right
 */
function registerNativeStringTypes(ctx: CodegenContext): void {
  // $__str_data: array of mutable i16 (WTF-16 code units)
  ctx.nativeStrDataTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "__str_data",
    element: { kind: "i16" },
    mutable: true,
  });

  // $AnyString: base type with just len (non-final, superTypeIdx = -1 means root)
  ctx.anyStrTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "AnyString",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: false },
    ],
    superTypeIdx: -1, // non-final root
  });

  // $NativeString (FlatString): sub $AnyString, fields: len, off, data
  ctx.nativeStrTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "NativeString",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: false },
      { name: "off", type: { kind: "i32" }, mutable: false },
      { name: "data", type: { kind: "ref", typeIdx: ctx.nativeStrDataTypeIdx }, mutable: false },
    ],
    superTypeIdx: ctx.anyStrTypeIdx,
  });

  // $ConsString: sub $AnyString, fields: len, left, right
  ctx.consStrTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "ConsString",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: false },
      { name: "left", type: { kind: "ref", typeIdx: ctx.anyStrTypeIdx }, mutable: false },
      { name: "right", type: { kind: "ref", typeIdx: ctx.anyStrTypeIdx }, mutable: false },
    ],
    superTypeIdx: ctx.anyStrTypeIdx,
  });
}

/**
 * Register the $AnyValue struct type for boxing `any` typed values.
 * The struct has a tag field to distinguish the boxed type at runtime,
 * plus payload fields for each possible value kind.
 *
 * Called lazily — only emitted when the module actually uses `any`-typed values.
 */
export function ensureAnyValueType(ctx: CodegenContext): void {
  if (ctx.anyValueTypeIdx >= 0) return; // already registered
  ctx.anyValueTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "AnyValue",
    fields: [
      { name: "tag", type: { kind: "i32" }, mutable: false },
      { name: "i32val", type: { kind: "i32" }, mutable: false },
      { name: "f64val", type: { kind: "f64" }, mutable: false },
      { name: "refval", type: { kind: "eqref" }, mutable: false },
      { name: "externval", type: { kind: "externref" }, mutable: false },
    ],
  });
}

/**
 * Lazily register wrapper struct types for Number, String, Boolean.
 * Each wrapper is a struct with a single `value` field holding the primitive.
 * Also registers WrapperX_valueOf functions that extract the value.
 * Must be called before resolveWasmType is used for wrapper types.
 */
export function ensureWrapperTypes(ctx: CodegenContext): void {
  if (ctx.wrapperNumberTypeIdx >= 0) return; // already registered

  // $WrapperNumber: struct { value: f64 }
  ctx.wrapperNumberTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "WrapperNumber",
    fields: [
      { name: "value", type: { kind: "f64" }, mutable: false },
    ],
  } as StructTypeDef);
  ctx.structMap.set("WrapperNumber", ctx.wrapperNumberTypeIdx);
  ctx.structFields.set("WrapperNumber", [
    { name: "value", type: { kind: "f64" }, mutable: false },
  ]);

  // $WrapperString: struct { value: externref }
  ctx.wrapperStringTypeIdx = ctx.mod.types.length;
  const strValType: ValType = ctx.fast ? nativeStringType(ctx) : { kind: "externref" };
  ctx.mod.types.push({
    kind: "struct",
    name: "WrapperString",
    fields: [
      { name: "value", type: strValType, mutable: false },
    ],
  } as StructTypeDef);
  ctx.structMap.set("WrapperString", ctx.wrapperStringTypeIdx);
  ctx.structFields.set("WrapperString", [
    { name: "value", type: strValType, mutable: false },
  ]);

  // $WrapperBoolean: struct { value: i32 }
  ctx.wrapperBooleanTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "WrapperBoolean",
    fields: [
      { name: "value", type: { kind: "i32" }, mutable: false },
    ],
  } as StructTypeDef);
  ctx.structMap.set("WrapperBoolean", ctx.wrapperBooleanTypeIdx);
  ctx.structFields.set("WrapperBoolean", [
    { name: "value", type: { kind: "i32" }, mutable: false },
  ]);
}

/**
 * Emit valueOf helper functions for wrapper types.
 * Must be called after all imports are registered (so function indices are stable)
 * but before user functions that call valueOf.
 */
function emitWrapperValueOfFunctions(ctx: CodegenContext): void {
  if (ctx.wrapperNumberTypeIdx < 0) return;
  if (ctx.funcMap.has("WrapperNumber_valueOf")) return; // already emitted

  const strValType: ValType = ctx.fast ? nativeStringType(ctx) : { kind: "externref" };

  // WrapperNumber_valueOf(self: ref $WrapperNumber) -> f64
  {
    const funcTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      params: [{ kind: "ref", typeIdx: ctx.wrapperNumberTypeIdx }],
      results: [{ kind: "f64" }],
    });
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: "WrapperNumber_valueOf",
      typeIdx: funcTypeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: ctx.wrapperNumberTypeIdx, fieldIdx: 0 },
      ] as Instr[],
    });
    ctx.funcMap.set("WrapperNumber_valueOf", funcIdx);
  }

  // WrapperString_valueOf(self: ref $WrapperString) -> externref/ref
  {
    const funcTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      params: [{ kind: "ref", typeIdx: ctx.wrapperStringTypeIdx }],
      results: [strValType],
    });
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: "WrapperString_valueOf",
      typeIdx: funcTypeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: ctx.wrapperStringTypeIdx, fieldIdx: 0 },
      ] as Instr[],
    });
    ctx.funcMap.set("WrapperString_valueOf", funcIdx);
  }

  // WrapperBoolean_valueOf(self: ref $WrapperBoolean) -> i32
  {
    const funcTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      params: [{ kind: "ref", typeIdx: ctx.wrapperBooleanTypeIdx }],
      results: [{ kind: "i32" }],
    });
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: "WrapperBoolean_valueOf",
      typeIdx: funcTypeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: ctx.wrapperBooleanTypeIdx, fieldIdx: 0 },
      ] as Instr[],
    });
    ctx.funcMap.set("WrapperBoolean_valueOf", funcIdx);
  }
}

/**
 * Check if a ValType represents a boxed `any` value (ref $AnyValue).
 */
export function isAnyValue(type: ValType, ctx: CodegenContext): boolean {
  return (
    (type.kind === "ref" || type.kind === "ref_null") &&
    (type as { typeIdx: number }).typeIdx === ctx.anyValueTypeIdx &&
    ctx.anyValueTypeIdx >= 0
  );
}

/**
 * Emit inline wasm helper functions for boxing/unboxing `any` values.
 * Called lazily when any-typed operations are first encountered.
 */
export function ensureAnyHelpers(ctx: CodegenContext): void {
  if (ctx.anyHelpersEmitted) return;
  ctx.anyHelpersEmitted = true;

  // Ensure the $AnyValue struct type is registered before emitting helpers
  ensureAnyValueType(ctx);

  const anyTypeIdx = ctx.anyValueTypeIdx;
  const anyRef: ValType = { kind: "ref", typeIdx: anyTypeIdx };
  const anyRefNull: ValType = { kind: "ref_null", typeIdx: anyTypeIdx };

  // Helper to register a helper function
  function addHelper(name: string, params: ValType[], results: ValType[], body: Instr[], locals?: { name: string; type: ValType }[]): void {
    const typeIdx = addFuncType(ctx, params, results, name);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name,
      typeIdx,
      locals: locals ?? [],
      body,
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
    ctx.anyHelpers.set(name, funcIdx);
  }

  // ref.null eq — the eq abstract heap type is encoded as byte 0x6d.
  // In signed LEB128 (used by enc.i32), 0x6d = -19 (7-bit two's complement).
  const EQ_HEAP_TYPE = -19; // signed LEB128 → 0x6d → TYPE.eq

  // __any_box_null() -> ref $AnyValue
  // tag=0, i32val=0, f64val=0.0, refval=null, externval=null
  addHelper("__any_box_null", [], [anyRef], [
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "f64.const", value: 0 },
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE } as unknown as Instr,
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ]);

  // __any_box_undefined() -> ref $AnyValue
  // tag=1
  addHelper("__any_box_undefined", [], [anyRef], [
    { op: "i32.const", value: 1 },
    { op: "i32.const", value: 0 },
    { op: "f64.const", value: 0 },
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE } as unknown as Instr,
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ]);

  // __any_box_i32(val: i32) -> ref $AnyValue
  // tag=2, i32val=val, f64val=0.0, refval=null, externval=null
  addHelper("__any_box_i32", [{ kind: "i32" }], [anyRef], [
    { op: "i32.const", value: 2 },
    { op: "local.get", index: 0 },
    { op: "f64.const", value: 0 },
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE } as unknown as Instr,
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ]);

  // __any_box_f64(val: f64) -> ref $AnyValue
  // tag=3, i32val=0, f64val=val, refval=null, externval=null
  addHelper("__any_box_f64", [{ kind: "f64" }], [anyRef], [
    { op: "i32.const", value: 3 },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: 0 },
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE } as unknown as Instr,
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ]);

  // __any_box_bool(val: i32) -> ref $AnyValue
  // tag=4, i32val=val, f64val=0.0, refval=null, externval=null
  addHelper("__any_box_bool", [{ kind: "i32" }], [anyRef], [
    { op: "i32.const", value: 4 },
    { op: "local.get", index: 0 },
    { op: "f64.const", value: 0 },
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE } as unknown as Instr,
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ]);

  // __any_box_string(val: externref) -> ref $AnyValue
  // tag=5, i32val=0, f64val=0.0, refval=null, externval=val
  addHelper("__any_box_string", [{ kind: "externref" }], [anyRef], [
    { op: "i32.const", value: 5 },
    { op: "i32.const", value: 0 },
    { op: "f64.const", value: 0 },
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE } as unknown as Instr,
    { op: "local.get", index: 0 },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ]);

  // __any_box_ref(val: eqref) -> ref $AnyValue
  // tag=6, i32val=0, f64val=0.0, refval=val, externval=null
  addHelper("__any_box_ref", [{ kind: "eqref" }], [anyRef], [
    { op: "i32.const", value: 6 },
    { op: "i32.const", value: 0 },
    { op: "f64.const", value: 0 },
    { op: "local.get", index: 0 },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ]);

  // __any_unbox_i32(val: ref $AnyValue) -> i32
  // Returns i32val field; if tag==3 (f64), truncate f64val
  addHelper("__any_unbox_i32", [anyRefNull], [{ kind: "i32" }], [
    // Check if tag == 3 (f64 number)
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: 3 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
        { op: "i32.trunc_sat_f64_s" },
      ],
      else: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
      ],
    } as unknown as Instr,
  ]);

  // __any_unbox_f64(val: ref $AnyValue) -> f64
  // Returns f64val field; if tag==2 (i32 number), convert i32val
  addHelper("__any_unbox_f64", [anyRefNull], [{ kind: "f64" }], [
    // Check if tag == 2 (i32 number)
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        { op: "f64.convert_i32_s" },
      ],
      else: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
      ],
    } as unknown as Instr,
  ]);

  // __any_unbox_bool(val: ref $AnyValue) -> i32
  // Truthiness check: tag 4 → i32val, tag 2 → i32val!=0, tag 3 → f64val!=0,
  // tag 0/1 → 0 (null/undefined), tag >= 5 → 1 (truthy object)
  addHelper("__any_unbox_bool", [anyRefNull], [{ kind: "i32" }], [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: 4 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
      ],
      else: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
            { op: "i32.const", value: 0 },
            { op: "i32.ne" },
          ],
          else: [
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
            { op: "i32.const", value: 3 },
            { op: "i32.eq" },
            { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: 0 },
                { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                { op: "f64.const", value: 0 },
                { op: "f64.ne" },
              ],
              else: [
                { op: "local.get", index: 0 },
                { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
                { op: "i32.const", value: 5 },
                { op: "i32.ge_s" },
              ],
            } as unknown as Instr,
          ],
        } as unknown as Instr,
      ],
    } as unknown as Instr,
  ]);

  // __any_unbox_extern(val: ref $AnyValue) -> externref
  // Returns externval field
  addHelper("__any_unbox_extern", [anyRefNull], [{ kind: "externref" }], [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
  ]);

  // ── Phase 2: Runtime dispatch operators ──────────────────────────

  // Helper: get numeric value as f64 from an AnyValue (assumes tag is 2 or 3)
  // Used internally by arithmetic helpers.
  // params: a(0)  locals: tag(1)
  // Returns f64 per JS ToNumber semantics:
  //   tag 0 (null) → 0, tag 1 (undefined) → NaN, tag 2 (i32) → f64(i32val),
  //   tag 3 (f64) → f64val, tag 4 (bool) → f64(i32val)
  addHelper("__any_to_f64", [anyRefNull], [{ kind: "f64" }], [
    // tag = a.tag
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 1 },
    // if tag == 1 (undefined) → NaN
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 1 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "f64.const", value: NaN },
      ],
      else: [
        // if tag == 2 (i32) or tag == 4 (bool) → convert i32val to f64
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 4 },
        { op: "i32.eq" },
        { op: "i32.or" },
        { op: "if", blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
            { op: "f64.convert_i32_s" },
          ],
          else: [
            // tag 0 (null) → f64val (0.0), tag 3 (f64) → f64val
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
          ],
        } as unknown as Instr,
      ],
    } as unknown as Instr,
  ], [
    { name: "tag", type: { kind: "i32" } },
  ]);

  const toF64Idx = ctx.funcMap.get("__any_to_f64")!;
  const boxI32Idx = ctx.funcMap.get("__any_box_i32")!;
  const boxF64Idx = ctx.funcMap.get("__any_box_f64")!;

  // __any_add(a: ref $AnyValue, b: ref $AnyValue) -> ref $AnyValue
  // If both are i32 (tag==2): i32.add, box as i32
  // If both are numeric (tag 2 or 3): convert to f64, f64.add, box as f64
  // Otherwise: trap (string concat via any not supported yet for simplicity)
  // params: a(0), b(1)  locals: tagA(2), tagB(3)
  addHelper("__any_add", [anyRefNull, anyRefNull], [anyRef], [
    // tagA = a.tag
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 2 },
    // tagB = b.tag
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 3 },
    // if tagA == 2 && tagB == 2 → i32 add
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "local.get", index: 3 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "val", type: anyRef },
      then: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        { op: "i32.add" },
        { op: "call", funcIdx: boxI32Idx },
      ],
      else: [
        // f64 path: convert both to f64, add, box as f64
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: toF64Idx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: toF64Idx },
        { op: "f64.add" },
        { op: "call", funcIdx: boxF64Idx },
      ],
    } as unknown as Instr,
  ], [
    { name: "tagA", type: { kind: "i32" } },
    { name: "tagB", type: { kind: "i32" } },
  ]);

  // Generic numeric binary op helper generator
  function addNumericBinaryHelper(
    name: string,
    i32op: string,
    f64op: string,
  ): void {
    addHelper(name, [anyRefNull, anyRefNull], [anyRef], [
      // tagA = a.tag
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },
      // tagB = b.tag
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // if tagA == 2 && tagB == 2 → i32 op
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      { op: "local.get", index: 3 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      { op: "i32.and" },
      { op: "if", blockType: { kind: "val", type: anyRef },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: i32op } as unknown as Instr,
          { op: "call", funcIdx: boxI32Idx },
        ],
        else: [
          // f64 path
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: toF64Idx },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: toF64Idx },
          { op: f64op } as unknown as Instr,
          { op: "call", funcIdx: boxF64Idx },
        ],
      } as unknown as Instr,
    ], [
      { name: "tagA", type: { kind: "i32" } },
      { name: "tagB", type: { kind: "i32" } },
    ]);
  }

  addNumericBinaryHelper("__any_sub", "i32.sub", "f64.sub");
  addNumericBinaryHelper("__any_mul", "i32.mul", "f64.mul");

  // __any_div: always use f64 (division can produce fractions)
  addHelper("__any_div", [anyRefNull, anyRefNull], [anyRef], [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: toF64Idx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: toF64Idx },
    { op: "f64.div" },
    { op: "call", funcIdx: boxF64Idx },
  ]);

  // __any_mod: i32.rem_s for i32, otherwise f64 approximation via floor division
  addHelper("__any_mod", [anyRefNull, anyRefNull], [anyRef], [
    // tagA = a.tag
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 2 },
    // tagB = b.tag
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 3 },
    // if tagA == 2 && tagB == 2 → i32 rem_s
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "local.get", index: 3 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "val", type: anyRef },
      then: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        { op: "i32.rem_s" },
        { op: "call", funcIdx: boxI32Idx },
      ],
      else: [
        // f64 path: a - floor(a/b) * b
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: toF64Idx },
        { op: "local.set", index: 4 }, // fA
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: toF64Idx },
        { op: "local.set", index: 5 }, // fB
        // result = fA - floor(fA / fB) * fB
        { op: "local.get", index: 4 },
        { op: "local.get", index: 4 },
        { op: "local.get", index: 5 },
        { op: "f64.div" },
        { op: "f64.floor" },
        { op: "local.get", index: 5 },
        { op: "f64.mul" },
        { op: "f64.sub" },
        { op: "call", funcIdx: boxF64Idx },
      ],
    } as unknown as Instr,
  ], [
    { name: "tagA", type: { kind: "i32" } },
    { name: "tagB", type: { kind: "i32" } },
    { name: "fA", type: { kind: "f64" } },
    { name: "fB", type: { kind: "f64" } },
  ]);

  // __any_eq(a, b) -> i32
  // Same tag: compare values. Different tag: return 0.
  addHelper("__any_eq", [anyRefNull, anyRefNull], [{ kind: "i32" }], [
    // tagA = a.tag
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 2 },
    // tagB = b.tag
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 3 },
    // if tagA != tagB → 0
    { op: "local.get", index: 2 },
    { op: "local.get", index: 3 },
    { op: "i32.ne" },
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        // Cross-tag numeric equality: if one is i32(2) and other is f64(3), compare as f64
        { op: "local.get", index: 2 },
        { op: "local.get", index: 3 },
        { op: "i32.add" },
        { op: "i32.const", value: 5 }, // 2+3 = 5
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: toF64Idx },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: toF64Idx },
            { op: "f64.eq" },
          ],
          else: [
            { op: "i32.const", value: 0 },
          ],
        } as unknown as Instr,
      ],
      else: [
        // Same tag — compare by tag type
        { op: "local.get", index: 2 },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            // i32 eq
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: 1 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
            { op: "i32.eq" },
          ],
          else: [
            { op: "local.get", index: 2 },
            { op: "i32.const", value: 3 },
            { op: "i32.eq" },
            { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                // f64 eq
                { op: "local.get", index: 0 },
                { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                { op: "local.get", index: 1 },
                { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                { op: "f64.eq" },
              ],
              else: [
                { op: "local.get", index: 2 },
                { op: "i32.const", value: 4 },
                { op: "i32.eq" },
                { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
                  then: [
                    // bool eq (compare i32val)
                    { op: "local.get", index: 0 },
                    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                    { op: "local.get", index: 1 },
                    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                    { op: "i32.eq" },
                  ],
                  else: [
                    // null/undefined: both same tag → equal
                    { op: "local.get", index: 2 },
                    { op: "i32.const", value: 2 },
                    { op: "i32.lt_s" },
                    // tag < 2 means 0 (null) or 1 (undefined), both equal to themselves
                  ],
                } as unknown as Instr,
              ],
            } as unknown as Instr,
          ],
        } as unknown as Instr,
      ],
    } as unknown as Instr,
  ], [
    { name: "tagA", type: { kind: "i32" } },
    { name: "tagB", type: { kind: "i32" } },
  ]);

  // __any_strict_eq(a, b) -> i32
  // Strict equality (===): different tags always return 0 (no cross-type coercion). (#296)
  addHelper("__any_strict_eq", [anyRefNull, anyRefNull], [{ kind: "i32" }], [
    // tagA = a.tag
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 2 },
    // tagB = b.tag
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 3 },
    // if tagA != tagB → 0 (strict: no cross-type coercion)
    { op: "local.get", index: 2 },
    { op: "local.get", index: 3 },
    { op: "i32.ne" },
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "i32.const", value: 0 },
      ],
      else: [
        // Same tag — compare by tag type
        { op: "local.get", index: 2 },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            // i32 eq
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: 1 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
            { op: "i32.eq" },
          ],
          else: [
            { op: "local.get", index: 2 },
            { op: "i32.const", value: 3 },
            { op: "i32.eq" },
            { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                // f64 eq
                { op: "local.get", index: 0 },
                { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                { op: "local.get", index: 1 },
                { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                { op: "f64.eq" },
              ],
              else: [
                { op: "local.get", index: 2 },
                { op: "i32.const", value: 4 },
                { op: "i32.eq" },
                { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
                  then: [
                    // bool eq (compare i32val)
                    { op: "local.get", index: 0 },
                    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                    { op: "local.get", index: 1 },
                    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                    { op: "i32.eq" },
                  ],
                  else: [
                    // null/undefined: both same tag → equal
                    { op: "local.get", index: 2 },
                    { op: "i32.const", value: 2 },
                    { op: "i32.lt_s" },
                    // tag < 2 means 0 (null) or 1 (undefined), both equal to themselves
                  ],
                } as unknown as Instr,
              ],
            } as unknown as Instr,
          ],
        } as unknown as Instr,
      ],
    } as unknown as Instr,
  ], [
    { name: "tagA", type: { kind: "i32" } },
    { name: "tagB", type: { kind: "i32" } },
  ]);

  // Comparison helpers: __any_lt, __any_gt, __any_le, __any_ge
  // All use numeric comparison (convert to f64, compare)
  function addComparisonHelper(name: string, f64op: string): void {
    addHelper(name, [anyRefNull, anyRefNull], [{ kind: "i32" }], [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: toF64Idx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: toF64Idx },
      { op: f64op } as unknown as Instr,
    ]);
  }

  addComparisonHelper("__any_lt", "f64.lt");
  addComparisonHelper("__any_gt", "f64.gt");
  addComparisonHelper("__any_le", "f64.le");
  addComparisonHelper("__any_ge", "f64.ge");

  // __any_neg(a) -> ref $AnyValue
  // Negate numeric value: tag 2 → negate i32, tag 3 → negate f64
  addHelper("__any_neg", [anyRefNull], [anyRef], [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "val", type: anyRef },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        { op: "i32.sub" },
        { op: "call", funcIdx: boxI32Idx },
      ],
      else: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
        { op: "f64.neg" },
        { op: "call", funcIdx: boxF64Idx },
      ],
    } as unknown as Instr,
  ]);

  // __any_typeof(a) -> ref $AnyString (native string in fast mode)
  // Returns "number", "string", "boolean", "object", "undefined" as native strings
  // Uses the $AnyString type system (WasmGC native strings)
  if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
    const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
    const strTypeIdx = ctx.nativeStrTypeIdx;

    // Helper to build a native string literal inline (returns instructions that leave ref $NativeString on stack)
    function nativeStrConstInstrs(value: string): Instr[] {
      const instrs: Instr[] = [];
      // Push len (i32) — field 0
      instrs.push({ op: "i32.const", value: value.length });
      // Push off (i32) = 0 — field 1
      instrs.push({ op: "i32.const", value: 0 });
      // Push each code unit and create array
      for (let i = 0; i < value.length; i++) {
        instrs.push({ op: "i32.const", value: value.charCodeAt(i) });
      }
      instrs.push({ op: "array.new_fixed", typeIdx: strDataTypeIdx, length: value.length });
      instrs.push({ op: "struct.new", typeIdx: strTypeIdx });
      return instrs;
    }

    const anyStrRef: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };

    addHelper("__any_typeof", [anyRefNull], [anyStrRef], [
      // Check tag and return corresponding string
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 }, // tag in local 1

      // tag == 0 (null) → "object"
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "val", type: anyStrRef },
        then: nativeStrConstInstrs("object"),
        else: [
          // tag == 1 (undefined) → "undefined"
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "val", type: anyStrRef },
            then: nativeStrConstInstrs("undefined"),
            else: [
              // tag == 2 or tag == 3 (i32/f64) → "number"
              { op: "local.get", index: 1 },
              { op: "i32.const", value: 2 },
              { op: "i32.eq" },
              { op: "local.get", index: 1 },
              { op: "i32.const", value: 3 },
              { op: "i32.eq" },
              { op: "i32.or" },
              { op: "if", blockType: { kind: "val", type: anyStrRef },
                then: nativeStrConstInstrs("number"),
                else: [
                  // tag == 4 (bool) → "boolean"
                  { op: "local.get", index: 1 },
                  { op: "i32.const", value: 4 },
                  { op: "i32.eq" },
                  { op: "if", blockType: { kind: "val", type: anyStrRef },
                    then: nativeStrConstInstrs("boolean"),
                    else: [
                      // tag == 5 (string/externref) or tag == 6 (gcref) — default to "object"
                      // (In practice tag 5 would be "string" but we don't use it in fast mode)
                      ...nativeStrConstInstrs("object"),
                    ],
                  } as unknown as Instr,
                ],
              } as unknown as Instr,
            ],
          } as unknown as Instr,
        ],
      } as unknown as Instr,
    ], [
      { name: "tag", type: { kind: "i32" } },
    ]);
  }
}

/**
 * Get the ValType for a string reference (ref $AnyString).
 * This is the abstract base type that represents any string (flat or cons).
 * Only valid when ctx.fast is true and native string types are registered.
 */
export function nativeStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * Get the nullable ValType for a string reference (ref null $AnyString).
 */
export function nativeStringTypeNullable(ctx: CodegenContext): ValType {
  return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * Get the ValType for a flat string reference (ref $NativeString).
 */
export function flatStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.nativeStrTypeIdx };
}

/**
 * Emit native string helper functions into the module.
 * Called lazily when string operations are first encountered in fast mode.
 *
 * IMPORTANT: All imports must be registered BEFORE any module functions,
 * because wasm function indices are: imports first, then module functions.
 */
export function ensureNativeStringHelpers(ctx: CodegenContext): void {
  if (ctx.nativeStrHelpersEmitted) return;
  ctx.nativeStrHelpersEmitted = true;

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;    // NativeString (FlatString) struct type index
  const anyStrTypeIdx = ctx.anyStrTypeIdx;    // AnyString base type index
  const consStrTypeIdx = ctx.consStrTypeIdx;  // ConsString type index
  // strRef = ref $AnyString — used in all helper function signatures (params and results).
  // All string values in the system can be either FlatString or ConsString.
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx };  // ref $NativeString
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // ── Step 1: Register ALL host imports first ──────────────────────
  // This must happen before any ctx.mod.functions.push() calls.

  // Add a 1-page linear memory for string marshaling
  if (ctx.mod.memories.length === 0) {
    ctx.mod.memories.push({ min: 1 });
    ctx.mod.exports.push({
      name: "__str_mem",
      desc: { kind: "memory", index: 0 },
    });
  }

  // __str_from_mem: (i32, i32) -> externref
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__str_from_mem", { kind: "func", typeIdx });
  }

  // __str_to_mem: (externref, i32) -> void
  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], []);
    addImport(ctx, "env", "__str_to_mem", { kind: "func", typeIdx });
  }

  // __str_extern_len: (externref) -> i32
  {
    const lenTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
    addImport(ctx, "env", "__str_extern_len", { kind: "func", typeIdx: lenTypeIdx });
  }

  // Helper: get the flatten function index (available after flatten is registered)
  const getFlattenIdx = () => ctx.nativeStrHelpers.get("__str_flatten")!;

  /**
   * Wrap a helper body with flatten preambles for string params.
   * For each string param index in `strParamIndices`, adds:
   *   local.get $param → call $__str_flatten → local.set $param
   * This ensures the param (typed ref $AnyString) actually holds a NativeString.
   * Also inserts ref.cast $NativeString before every struct.get $NativeString
   * to satisfy the wasm type checker.
   */
  function wrapBodyWithFlatten(body: Instr[], strParamIndices: number[]): Instr[] {
    // 1. Build flatten preamble
    const preamble: Instr[] = [];
    for (const idx of strParamIndices) {
      preamble.push(
        { op: "local.get", index: idx },
        { op: "call", funcIdx: getFlattenIdx() },
        // flatten returns ref $NativeString which is subtype of ref $AnyString — can store in param
        { op: "local.set", index: idx },
      );
    }

    // 2. Insert ref.cast before every struct.get $NativeString
    const processed: Instr[] = [];
    for (const instr of body) {
      if (instr.op === "struct.get" && (instr as any).typeIdx === strTypeIdx) {
        processed.push({ op: "ref.cast", typeIdx: strTypeIdx });
      }
      // Recurse into if/block/loop bodies
      if (instr.op === "if") {
        const ifInstr = instr as any;
        const newIf: any = { ...ifInstr };
        if (ifInstr.then) newIf.then = wrapBodyWithFlatten(ifInstr.then, []).slice(0); // no preamble for sub-bodies
        if (ifInstr.else) newIf.else = wrapBodyWithFlatten(ifInstr.else, []).slice(0);
        processed.push(newIf);
        continue;
      }
      if (instr.op === "block" || instr.op === "loop") {
        const blockInstr = instr as any;
        const newBlock: any = { ...blockInstr };
        if (blockInstr.body) newBlock.body = wrapBodyWithFlatten(blockInstr.body, []).slice(0);
        processed.push(newBlock);
        continue;
      }
      processed.push(instr);
    }

    return [...preamble, ...processed];
  }

  // ── Step 2: Now add all module functions ─────────────────────────

  // --- $__str_copy_tree(node: ref $AnyString, buf: ref $__str_data, pos: i32) -> i32 ---
  // Recursively copies rope tree into a flat buffer. Returns next write position.
  {
    const typeIdx = addFuncType(ctx, [strRef, strDataRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_copy_tree", funcIdx);

    // params: node(0), buf(1), pos(2)
    // locals: flat(3), flatOff(4), flatLen(5), left(6), right(7)
    const body: Instr[] = [
      // if node is FlatString: array.copy and return pos + len
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: strTypeIdx },
      { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // flat = ref.cast $NativeString node
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: strTypeIdx },
          { op: "local.set", index: 3 },

          // flatOff = flat.off (field 1)
          { op: "local.get", index: 3 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
          { op: "local.set", index: 4 },

          // flatLen = flat.len (field 0)
          { op: "local.get", index: 3 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 5 },

          // array.copy(buf, pos, flat.data, flatOff, flatLen)
          { op: "local.get", index: 1 },       // dst = buf
          { op: "local.get", index: 2 },       // dstOffset = pos
          { op: "local.get", index: 3 },       // flat
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flat.data
          { op: "local.get", index: 4 },       // srcOffset = flatOff
          { op: "local.get", index: 5 },       // length = flatLen
          { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

          // return pos + flatLen
          { op: "local.get", index: 2 },
          { op: "local.get", index: 5 },
          { op: "i32.add" },
        ],
        else: [
          // node is ConsString
          // left = cons.left (field 1)
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: consStrTypeIdx },
          { op: "struct.get", typeIdx: consStrTypeIdx, fieldIdx: 1 }, // left
          { op: "local.set", index: 6 },  // left

          // right = cons.right
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: consStrTypeIdx },
          { op: "struct.get", typeIdx: consStrTypeIdx, fieldIdx: 2 }, // right
          { op: "local.set", index: 7 },  // right

          // pos = copy_tree(left, buf, pos)
          { op: "local.get", index: 6 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx },  // recursive call to self

          // return copy_tree(right, buf, pos)
          // pos is now the return value on the stack — use it directly
          { op: "local.set", index: 2 },  // update pos
          { op: "local.get", index: 7 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx },  // recursive call to self
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_copy_tree",
      typeIdx,
      locals: [
        { name: "flat", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatOff", type: { kind: "i32" } },
        { name: "flatLen", type: { kind: "i32" } },
        { name: "left", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "right", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_flatten(s: ref $AnyString) -> ref $NativeString ---
  // If s is already a FlatString, returns it. Otherwise flattens the rope tree.
  {
    const typeIdx = addFuncType(ctx, [strRef], [flatStrRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_flatten", funcIdx);

    const copyTreeIdx = ctx.nativeStrHelpers.get("__str_copy_tree")!;

    // params: s(0)
    // locals: len(1), buf(2)
    const body: Instr[] = [
      // if s is already a FlatString, return it
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: strTypeIdx },
      { op: "if", blockType: { kind: "val", type: flatStrRef },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: strTypeIdx },
        ],
        else: [
          // len = s.len (field 0 of AnyString)
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 1 },

          // buf = array.new_default(len)
          { op: "local.get", index: 1 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 2 },

          // copy_tree(s, buf, 0)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: copyTreeIdx },
          { op: "drop" },  // discard returned position

          // return struct.new $NativeString(len, 0, buf)
          { op: "local.get", index: 1 },  // len
          { op: "i32.const", value: 0 },  // off = 0
          { op: "local.get", index: 2 },  // data = buf
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_flatten",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "buf", type: strDataRef },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_concat(a: ref $AnyString, b: ref $AnyString) -> ref $AnyString ---
  // For short strings (combined length < 64), copies into a flat string.
  // For longer strings, creates a ConsString node in O(1).
  {
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const typeIdx = addFuncType(ctx, [strRef, strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_concat", funcIdx);

    // params: a(0), b(1)
    // locals: lenA(2), lenB(3), newLen(4), newArr(5), flatA(6), flatB(7)
    const body: Instr[] = [
      // lenA = a.len (field 0 of AnyString)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 }, // lenA

      // lenB = b.len (field 0 of AnyString)
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // lenB

      // newLen = lenA + lenB
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 4 }, // newLen

      // if newLen >= 64, create ConsString (O(1) rope node)
      { op: "local.get", index: 4 },
      { op: "i32.const", value: 64 },
      { op: "i32.ge_u" },
      { op: "if", blockType: { kind: "val", type: strRef },
        then: [
          // struct.new $ConsString(newLen, a, b)
          { op: "local.get", index: 4 },  // len = newLen
          { op: "local.get", index: 0 },  // left = a
          { op: "local.get", index: 1 },  // right = b
          { op: "struct.new", typeIdx: consStrTypeIdx },
        ],
        else: [
          // Short string: flatten both sides and copy
          // flatA = flatten(a)
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: 6 },

          // flatB = flatten(b)
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: 7 },

          // newArr = array.new_default(newLen)
          { op: "local.get", index: 4 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 5 },

          // array.copy(newArr, 0, flatA.data, flatA.off, lenA)
          { op: "local.get", index: 5 },       // dst
          { op: "ref.as_non_null" },
          { op: "i32.const", value: 0 },        // dstOffset
          { op: "local.get", index: 6 },        // flatA
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatA.data
          { op: "local.get", index: 6 },        // flatA
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatA.off
          { op: "local.get", index: 2 },        // lenA
          { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

          // array.copy(newArr, lenA, flatB.data, flatB.off, lenB)
          { op: "local.get", index: 5 },       // dst
          { op: "ref.as_non_null" },
          { op: "local.get", index: 2 },        // dstOffset = lenA
          { op: "local.get", index: 7 },        // flatB
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatB.data
          { op: "local.get", index: 7 },        // flatB
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatB.off
          { op: "local.get", index: 3 },        // lenB
          { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

          // result = struct.new $NativeString(newLen, 0, newArr)
          { op: "local.get", index: 4 },        // len = newLen
          { op: "i32.const", value: 0 },        // off = 0
          { op: "local.get", index: 5 },        // data = newArr
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_concat",
      typeIdx,
      locals: [
        { name: "lenA", type: { kind: "i32" } },
        { name: "lenB", type: { kind: "i32" } },
        { name: "newLen", type: { kind: "i32" } },
        { name: "newArr", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
        { name: "flatA", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatB", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_equals(a: ref $NativeString, b: ref $NativeString) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_equals", funcIdx);

    // locals: len(2), i(3), aData(4), bData(5), aOff(6), bOff(7)
    const body: Instr[] = [
      // len = a.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 }, // len

      // if a.len != b.len return 0
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ne" },
      { op: "if", blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },

      // aOff = a.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // bOff = b.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 7 },

      // aData = a.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 4 },

      // bData = b.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },

      // loop: compare element by element
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          // if i >= len, break (strings are equal)
          { op: "local.get", index: 3 },
          { op: "local.get", index: 2 },
          { op: "i32.ge_u" },
          { op: "br_if", depth: 1 },

          // if aData[aOff + i] != bData[bOff + i], return 0
          { op: "local.get", index: 4 },
          { op: "local.get", index: 6 },
          { op: "local.get", index: 3 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.get", index: 5 },
          { op: "local.get", index: 7 },
          { op: "local.get", index: 3 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "i32.ne" },
          { op: "if", blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 0 }, { op: "return" }],
          },

          // i++
          { op: "local.get", index: 3 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 3 },
          { op: "br", depth: 0 },
        ]},
      ]},

      // return 1 (equal)
      { op: "i32.const", value: 1 },
    ];

    ctx.mod.functions.push({
      name: "__str_equals",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "aData", type: strDataRef },
        { name: "bData", type: strDataRef },
        { name: "aOff", type: { kind: "i32" } },
        { name: "bOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_compare(a: ref $NativeString, b: ref $NativeString) -> i32 ---
  // Lexicographic comparison: returns -1 (a < b), 0 (a == b), or 1 (a > b)
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_compare", funcIdx);

    // locals: lenA(2), lenB(3), minLen(4), i(5), aData(6), bData(7), aOff(8), bOff(9), ca(10), cb(11)
    const body: Instr[] = [
      // lenA = a.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // lenB = b.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // minLen = min(lenA, lenB)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_u" },
      { op: "select" },
      { op: "local.set", index: 4 },

      // aOff = a.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 8 },

      // bOff = b.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },

      // aData = a.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },

      // bData = b.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },

      // loop: compare element by element
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          // if i >= minLen, break (common prefix is equal)
          { op: "local.get", index: 5 },
          { op: "local.get", index: 4 },
          { op: "i32.ge_u" },
          { op: "br_if", depth: 1 },

          // ca = aData[aOff + i]
          { op: "local.get", index: 6 },
          { op: "local.get", index: 8 },
          { op: "local.get", index: 5 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 10 },

          // cb = bData[bOff + i]
          { op: "local.get", index: 7 },
          { op: "local.get", index: 9 },
          { op: "local.get", index: 5 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 11 },

          // if ca < cb return -1
          { op: "local.get", index: 10 },
          { op: "local.get", index: 11 },
          { op: "i32.lt_u" },
          { op: "if", blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: -1 }, { op: "return" }],
          },

          // if ca > cb return 1
          { op: "local.get", index: 10 },
          { op: "local.get", index: 11 },
          { op: "i32.gt_u" },
          { op: "if", blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 1 }, { op: "return" }],
          },

          // i++
          { op: "local.get", index: 5 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 5 },
          { op: "br", depth: 0 },
        ]},
      ]},

      // Common prefix is equal; compare by length
      // if lenA < lenB return -1
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_u" },
      { op: "if", blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" }],
      },

      // if lenA > lenB return 1
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.gt_u" },
      { op: "if", blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },

      // return 0 (equal)
      { op: "i32.const", value: 0 },
    ];

    ctx.mod.functions.push({
      name: "__str_compare",
      typeIdx,
      locals: [
        { name: "lenA", type: { kind: "i32" } },
        { name: "lenB", type: { kind: "i32" } },
        { name: "minLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "aData", type: strDataRef },
        { name: "bData", type: strDataRef },
        { name: "aOff", type: { kind: "i32" } },
        { name: "bOff", type: { kind: "i32" } },
        { name: "ca", type: { kind: "i32" } },
        { name: "cb", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_substring(s: ref $NativeString, start: i32, end: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_substring", funcIdx);

    // O(1) substring: creates a view sharing the backing array.
    // locals: sOff(3), sLen(4)
    const body: Instr[] = [
      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 },

      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },

      // Clamp start: max(0, min(start, sLen))
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.tee", index: 1 },  // start = max(0, start)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 4 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 1 },  // start = min(start, sLen)

      // Clamp end: max(0, min(end, sLen))
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.tee", index: 2 },  // end = max(0, end)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },  // end = min(end, sLen)

      // Swap if start > end (JS substring semantics)
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "i32.gt_s" },
      { op: "if", blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "local.get", index: 1 },
          { op: "local.set", index: 2 },
          { op: "local.set", index: 1 },
        ],
      },

      // struct.new(len = end - start, off = sOff + start, s.data)
      { op: "local.get", index: 2 },   // end
      { op: "local.get", index: 1 },   // start
      { op: "i32.sub" },               // len = end - start
      { op: "local.get", index: 3 },   // sOff
      { op: "local.get", index: 1 },   // start
      { op: "i32.add" },               // off = sOff + start
      { op: "local.get", index: 0 },   // s
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // s.data
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_substring",
      typeIdx,
      locals: [
        { name: "sOff", type: { kind: "i32" } },
        { name: "sLen", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_charAt(s: ref $NativeString, idx: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_charAt", funcIdx);

    const body: Instr[] = [
      // Bounds check: if idx < 0 || idx >= s.len, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      { op: "i32.or" },
      { op: "if", blockType: { kind: "val", type: strRef },
        then: [
          // empty string: off=0, len=0, empty array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // Single-char string: len=1, off=0, [char]
          { op: "i32.const", value: 1 }, // len
          { op: "i32.const", value: 0 }, // off
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
          { op: "local.get", index: 1 },
          { op: "i32.add" }, // off + idx
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          // Create single-element array
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    ctx.mod.functions.push({
      name: "__str_charAt",
      typeIdx,
      locals: [],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_slice(s: ref $NativeString, start: i32, end: i32) -> ref $NativeString ---
  // Like substring but handles negative indices
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_slice", funcIdx);

    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // locals: len (index 3)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // len

      // Resolve negative start: if start < 0, start = len + start
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "if", blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 1 }, // start (negative)
          { op: "i32.add" },
          { op: "local.set", index: 1 },
        ],
      },
      // Clamp start to >= 0
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "if", blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 1 },
        ],
      },

      // Resolve negative end: if end < 0, end = len + end
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "if", blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 2 }, // end (negative)
          { op: "i32.add" },
          { op: "local.set", index: 2 },
        ],
      },
      // Clamp end to >= 0
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "if", blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 2 },
        ],
      },

      // Delegate to __str_substring (which handles clamping to len and swapping)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: substringIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_slice",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_indexOf(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_indexOf", funcIdx);

    // params: haystack(0), needle(1), fromIndex(2)
    // locals: hLen(3), nLen(4), i(5), j(6), hData(7), nData(8), hOff(9), nOff(10)
    const body: Instr[] = [
      // hLen = haystack.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // nLen = needle.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // if nLen == 0, return clamp(fromIndex, 0, hLen)
      { op: "local.get", index: 4 },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [
        { op: "local.get", index: 2 },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 2 },
        { op: "i32.const", value: 0 },
        { op: "i32.gt_s" },
        { op: "select" },
        { op: "local.tee", index: 5 },
        { op: "local.get", index: 3 },
        { op: "local.get", index: 5 },
        { op: "local.get", index: 3 },
        { op: "i32.lt_s" },
        { op: "select" },
        { op: "return" },
      ] },
      // hOff = haystack.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      // nOff = needle.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // hData = haystack.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      // nData = needle.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },
      // i = max(fromIndex, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // outer loop: scan i from fromIndex to hLen - nLen
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          // if i > hLen - nLen, break
          { op: "local.get", index: 5 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 4 },
          { op: "i32.sub" },
          { op: "i32.gt_s" },
          { op: "br_if", depth: 1 },
          // j = 0; inner loop to compare needle chars
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 6 },
          { op: "block", blockType: { kind: "empty" }, body: [
            { op: "loop", blockType: { kind: "empty" }, body: [
              // if j >= nLen, match found — return i
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "if", blockType: { kind: "empty" }, then: [
                { op: "local.get", index: 5 },
                { op: "return" },
              ] },
              // if hData[hOff + i + j] != nData[nOff + j], break inner
              { op: "local.get", index: 7 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "local.get", index: 6 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.get", index: 8 },
              { op: "local.get", index: 10 },
              { op: "local.get", index: 6 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              { op: "br_if", depth: 1 },
              // j++
              { op: "local.get", index: 6 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 6 },
              { op: "br", depth: 0 },
            ]},
          ]},
          // i++
          { op: "local.get", index: 5 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 5 },
          { op: "br", depth: 0 },
        ]},
      ]},
      // not found
      { op: "i32.const", value: -1 },
    ];

    ctx.mod.functions.push({
      name: "__str_indexOf",
      typeIdx,
      locals: [
        { name: "hLen", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "hData", type: strDataRef },
        { name: "nData", type: strDataRef },
        { name: "hOff", type: { kind: "i32" } },
        { name: "nOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_lastIndexOf(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_lastIndexOf", funcIdx);

    // params: haystack(0), needle(1), fromIndex(2)
    // locals: hLen(3), nLen(4), i(5), j(6), hData(7), nData(8), hOff(9), nOff(10)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // if nLen == 0, return min(fromIndex, hLen)
      { op: "local.get", index: 4 },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [
        { op: "local.get", index: 2 },
        { op: "local.get", index: 3 },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 3 },
        { op: "i32.lt_s" },
        { op: "select" },
        { op: "return" },
      ] },
      // hOff, nOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // hData, nData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },
      // i = min(fromIndex, hLen - nLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 4 },
      { op: "i32.sub" },
      { op: "local.tee", index: 5 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 5 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // reverse scan
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          { op: "local.get", index: 5 },
          { op: "i32.const", value: 0 },
          { op: "i32.lt_s" },
          { op: "br_if", depth: 1 },
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 6 },
          { op: "block", blockType: { kind: "empty" }, body: [
            { op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "if", blockType: { kind: "empty" }, then: [
                { op: "local.get", index: 5 },
                { op: "return" },
              ] },
              // hData[hOff + i + j]
              { op: "local.get", index: 7 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "local.get", index: 6 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              // nData[nOff + j]
              { op: "local.get", index: 8 },
              { op: "local.get", index: 10 },
              { op: "local.get", index: 6 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 6 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 6 },
              { op: "br", depth: 0 },
            ]},
          ]},
          { op: "local.get", index: 5 },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "local.set", index: 5 },
          { op: "br", depth: 0 },
        ]},
      ]},
      // not found
      { op: "i32.const", value: -1 },
    ];

    ctx.mod.functions.push({
      name: "__str_lastIndexOf",
      typeIdx,
      locals: [
        { name: "hLen", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "hData", type: strDataRef },
        { name: "nData", type: strDataRef },
        { name: "hOff", type: { kind: "i32" } },
        { name: "nOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_includes(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_includes", funcIdx);

    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: indexOfIdx },
      { op: "i32.const", value: -1 },
      { op: "i32.ne" },
    ];

    ctx.mod.functions.push({
      name: "__str_includes",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_startsWith(s: ref $NativeString, prefix: ref $NativeString, position: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_startsWith", funcIdx);

    // params: s(0), prefix(1), position(2)
    // locals: sLen(3), pLen(4), i(5), sData(6), pData(7), sOff(8), pOff(9)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // if position + pLen > sLen, return 0
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "i32.add" },
      { op: "local.get", index: 3 },
      { op: "i32.gt_s" },
      { op: "if", blockType: { kind: "empty" }, then: [
        { op: "i32.const", value: 0 },
        { op: "return" },
      ] },
      // sOff, pOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 8 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      // sData, pData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      // compare loop
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          { op: "local.get", index: 5 },
          { op: "local.get", index: 4 },
          { op: "i32.ge_s" },
          { op: "if", blockType: { kind: "empty" }, then: [
            { op: "i32.const", value: 1 },
            { op: "return" },
          ] },
          // sData[sOff + position + i]
          { op: "local.get", index: 6 },
          { op: "local.get", index: 8 },
          { op: "local.get", index: 2 },
          { op: "i32.add" },
          { op: "local.get", index: 5 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          // pData[pOff + i]
          { op: "local.get", index: 7 },
          { op: "local.get", index: 9 },
          { op: "local.get", index: 5 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "i32.ne" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: 5 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 5 },
          { op: "br", depth: 0 },
        ]},
      ]},
      // mismatch found
      { op: "i32.const", value: 0 },
    ];

    ctx.mod.functions.push({
      name: "__str_startsWith",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "pLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "pData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
        { name: "pOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_endsWith(s: ref $NativeString, suffix: ref $NativeString, endPos: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_endsWith", funcIdx);

    // params: s(0), suffix(1), endPos(2)
    // locals: sxLen(3), i(4), sData(5), xData(6), startPos(7), sLen(8), sOff(9), xOff(10)
    const body: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // sLen = s.len; clamp endPos to sLen
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 8 },
      // endPos = min(endPos, sLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 8 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 8 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // startPos = endPos - sxLen
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.sub" },
      { op: "local.set", index: 7 },
      // if startPos < 0, return 0
      { op: "local.get", index: 7 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "if", blockType: { kind: "empty" }, then: [
        { op: "i32.const", value: 0 },
        { op: "return" },
      ] },
      // sOff, xOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // sData, xData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          { op: "local.get", index: 4 },
          { op: "local.get", index: 3 },
          { op: "i32.ge_s" },
          { op: "if", blockType: { kind: "empty" }, then: [
            { op: "i32.const", value: 1 },
            { op: "return" },
          ] },
          // sData[sOff + startPos + i]
          { op: "local.get", index: 5 },
          { op: "local.get", index: 9 },
          { op: "local.get", index: 7 },
          { op: "i32.add" },
          { op: "local.get", index: 4 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          // xData[xOff + i]
          { op: "local.get", index: 6 },
          { op: "local.get", index: 10 },
          { op: "local.get", index: 4 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "i32.ne" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: 4 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 4 },
          { op: "br", depth: 0 },
        ]},
      ]},
      { op: "i32.const", value: 0 },
    ];

    ctx.mod.functions.push({
      name: "__str_endsWith",
      typeIdx,
      locals: [
        { name: "sxLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "xData", type: strDataRef },
        { name: "startPos", type: { kind: "i32" } },
        { name: "sLen", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
        { name: "xOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_isWhitespace(codeUnit: i32) -> i32 (helper, not exported) ---
  // Checks if a WTF-16 code unit is whitespace: 0x09-0x0D, 0x20, 0xA0, 0xFEFF
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_isWhitespace", funcIdx);

    const body: Instr[] = [
      // Check ranges: 0x09 <= c <= 0x0D || c == 0x20 || c == 0xA0 || c == 0xFEFF
      // Use a chain of comparisons
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0x20 },
      { op: "i32.eq" },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0x09 },
      { op: "i32.ge_u" },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0x0D },
      { op: "i32.le_u" },
      { op: "i32.and" },
      { op: "i32.or" },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0xA0 },
      { op: "i32.eq" },
      { op: "i32.or" },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0xFEFF },
      { op: "i32.eq" },
      { op: "i32.or" },
    ];

    ctx.mod.functions.push({
      name: "__str_isWhitespace",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_trimStart(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_trimStart", funcIdx);

    const isWsIdx = ctx.nativeStrHelpers.get("__str_isWhitespace")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0)
    // locals: len(1), i(2), sData(3), sOff(4)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 }, // sOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 3 }, // sData
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
      // scan forward while whitespace
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          { op: "local.get", index: 2 },
          { op: "local.get", index: 1 },
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          // sData[sOff + i]
          { op: "local.get", index: 3 },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 2 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "call", funcIdx: isWsIdx },
          { op: "i32.eqz" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 2 },
          { op: "br", depth: 0 },
        ]},
      ]},
      // return substring(s, i, len)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: substringIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_trimStart",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_trimEnd(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_trimEnd", funcIdx);

    const isWsIdx = ctx.nativeStrHelpers.get("__str_isWhitespace")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0)
    // locals: end(1), sData(2), sOff(3)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 }, // end = len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 }, // sOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 }, // sData
      // scan backward while whitespace
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 0 },
          { op: "i32.le_s" },
          { op: "br_if", depth: 1 },
          // sData[sOff + end - 1]
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 1 },
          { op: "i32.add" },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "call", funcIdx: isWsIdx },
          { op: "i32.eqz" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "local.set", index: 1 },
          { op: "br", depth: 0 },
        ]},
      ]},
      // return substring(s, 0, end)
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: substringIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_trimEnd",
      typeIdx,
      locals: [
        { name: "end", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_trim(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_trim", funcIdx);

    const trimStartIdx = ctx.nativeStrHelpers.get("__str_trimStart")!;
    const trimEndIdx = ctx.nativeStrHelpers.get("__str_trimEnd")!;

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: trimStartIdx },
      { op: "call", funcIdx: trimEndIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_trim",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_repeat(s: ref $NativeString, count: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_repeat", funcIdx);

    // params: s(0), count(1)
    // locals: sLen(2), newLen(3), newArr(4), dst(5), srcData(6), copyI(7), sOff(8)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // if count <= 0 or sLen == 0, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.le_s" },
      { op: "if", blockType: { kind: "val", type: strRef }, then: [
        { op: "i32.const", value: 0 },  // off = 0
        { op: "i32.const", value: 0 },  // len = 0
        { op: "i32.const", value: 0 },
        { op: "array.new_default", typeIdx: strDataTypeIdx },
        { op: "struct.new", typeIdx: strTypeIdx },
      ], else: [
        { op: "local.get", index: 2 },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "val", type: strRef }, then: [
          { op: "i32.const", value: 0 },  // off = 0
          { op: "i32.const", value: 0 },  // len = 0
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ], else: [
          // sOff = s.off
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
          { op: "local.set", index: 8 },

          // newLen = sLen * count
          { op: "local.get", index: 2 },
          { op: "local.get", index: 1 },
          { op: "i32.mul" },
          { op: "local.tee", index: 3 },

          // newArr = array.new_default(newLen)
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 4 },

          // srcData = s.data
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
          { op: "local.set", index: 6 },

          // dst = 0
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 5 },

          // outer loop: repeat count times
          { op: "block", blockType: { kind: "empty" }, body: [
            { op: "loop", blockType: { kind: "empty" }, body: [
              { op: "local.get", index: 5 },
              { op: "local.get", index: 3 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // array.copy newArr[dst..] <- srcData[sOff..sOff+sLen]
              { op: "local.get", index: 4 },   // dst array
              { op: "local.get", index: 5 },   // dst offset
              { op: "local.get", index: 6 },   // src array
              { op: "local.get", index: 8 },   // src offset = sOff
              { op: "local.get", index: 2 },   // length = sLen
              { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

              // dst += sLen
              { op: "local.get", index: 5 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ]},
          ]},

          // return struct.new(newLen, 0, newArr)
          { op: "local.get", index: 3 },  // len = newLen
          { op: "i32.const", value: 0 },  // off = 0
          { op: "local.get", index: 4 },  // data = newArr
          { op: "struct.new", typeIdx: strTypeIdx },
        ]},
      ]},
    ];

    ctx.mod.functions.push({
      name: "__str_repeat",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "newLen", type: { kind: "i32" } },
        { name: "newArr", type: strDataRef },
        { name: "dst", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "copyI", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_padStart(s: ref $NativeString, targetLen: i32, padStr: ref $NativeString) -> ref $NativeString ---
  {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const repeatIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_padStart", funcIdx);

    // params: s(0), targetLen(1), padStr(2)
    // locals: sLen(3), padLen(4), fillLen(5), repeated(6), prefix(7)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // if sLen >= targetLen, return s
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "i32.ge_s" },
      { op: "if", blockType: { kind: "val", type: strRef }, then: [
        { op: "local.get", index: 0 },
      ], else: [
        // padLen = padStr.len
        { op: "local.get", index: 2 },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 4 },

        // if padLen == 0, return s
        { op: "local.get", index: 4 },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "val", type: strRef }, then: [
          { op: "local.get", index: 0 },
        ], else: [
          // fillLen = targetLen - sLen
          { op: "local.get", index: 1 },
          { op: "local.get", index: 3 },
          { op: "i32.sub" },
          { op: "local.set", index: 5 },

          // repeated = repeat(padStr, ceil(fillLen / padLen))
          { op: "local.get", index: 2 },  // padStr (1st arg)
          { op: "local.get", index: 5 },   // fillLen
          { op: "local.get", index: 4 },   // padLen
          { op: "i32.add" },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "local.get", index: 4 },
          { op: "i32.div_u" },             // count (2nd arg)
          { op: "call", funcIdx: repeatIdx },

          // prefix = repeated.substring(0, fillLen)
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 5 },
          { op: "call", funcIdx: substringIdx },

          // return concat(prefix, s)
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: concatIdx },
        ]},
      ]},
    ];

    ctx.mod.functions.push({
      name: "__str_padStart",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "padLen", type: { kind: "i32" } },
        { name: "fillLen", type: { kind: "i32" } },
        { name: "repeated", type: strRef },
        { name: "prefix", type: strRef },
      ],
      body: wrapBodyWithFlatten(body, [0, 2]),
      exported: false,
    });
  }

  // --- $__str_padEnd(s: ref $NativeString, targetLen: i32, padStr: ref $NativeString) -> ref $NativeString ---
  {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const repeatIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_padEnd", funcIdx);

    // params: s(0), targetLen(1), padStr(2)
    // locals: sLen(3), padLen(4), fillLen(5)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // if sLen >= targetLen, return s
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "i32.ge_s" },
      { op: "if", blockType: { kind: "val", type: strRef }, then: [
        { op: "local.get", index: 0 },
      ], else: [
        // padLen = padStr.len
        { op: "local.get", index: 2 },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 4 },

        // if padLen == 0, return s
        { op: "local.get", index: 4 },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "val", type: strRef }, then: [
          { op: "local.get", index: 0 },
        ], else: [
          // fillLen = targetLen - sLen
          { op: "local.get", index: 1 },
          { op: "local.get", index: 3 },
          { op: "i32.sub" },
          { op: "local.set", index: 5 },

          // repeated = repeat(padStr, ceil(fillLen / padLen))
          { op: "local.get", index: 2 },  // padStr (1st arg)
          { op: "local.get", index: 5 },   // fillLen
          { op: "local.get", index: 4 },   // padLen
          { op: "i32.add" },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "local.get", index: 4 },
          { op: "i32.div_u" },             // count (2nd arg)
          { op: "call", funcIdx: repeatIdx },

          // suffix = repeated.substring(0, fillLen)
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 5 },
          { op: "call", funcIdx: substringIdx },

          // return concat(s, suffix)
          // stack has: suffix on top. Store it, push s, push suffix back
          { op: "local.set", index: 6 },   // suffix -> local 6
          { op: "local.get", index: 0 },   // s (1st arg to concat)
          { op: "local.get", index: 6 },   // suffix (2nd arg to concat)
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: concatIdx },
        ]},
      ]},
    ];

    ctx.mod.functions.push({
      name: "__str_padEnd",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "padLen", type: { kind: "i32" } },
        { name: "fillLen", type: { kind: "i32" } },
        { name: "suffix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 2]),
      exported: false,
    });
  }

  // --- $__str_toLowerCase(s: ref $NativeString) -> ref $NativeString ---
  // ASCII-only: maps A-Z (65-90) to a-z (97-122), copies everything else as-is
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_toLowerCase", funcIdx);

    // params: s(0)
    // locals: len(1), srcData(2), newArr(3), i(4), ch(5), sOff(6)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // srcData = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },

      // newArr = array.new_default(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 3 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },

      // loop over each code unit
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          { op: "local.get", index: 4 },
          { op: "local.get", index: 1 },
          { op: "i32.ge_u" },
          { op: "br_if", depth: 1 },

          // ch = srcData[sOff + i]
          { op: "local.get", index: 2 },
          { op: "local.get", index: 6 },
          { op: "local.get", index: 4 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 5 },

          // newArr[i] = (ch >= 65 && ch <= 90) ? ch + 32 : ch
          { op: "local.get", index: 3 },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 5 },
          { op: "i32.const", value: 65 },
          { op: "i32.ge_u" },
          { op: "local.get", index: 5 },
          { op: "i32.const", value: 90 },
          { op: "i32.le_u" },
          { op: "i32.and" },
          { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: [
            { op: "local.get", index: 5 },
            { op: "i32.const", value: 32 },
            { op: "i32.add" },
          ], else: [
            { op: "local.get", index: 5 },
          ]},
          { op: "array.set", typeIdx: strDataTypeIdx },

          // i++
          { op: "local.get", index: 4 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 4 },
          { op: "br", depth: 0 },
        ]},
      ]},

      // return struct.new(len, 0, newArr)
      { op: "local.get", index: 1 },  // len
      { op: "i32.const", value: 0 },  // off = 0
      { op: "local.get", index: 3 },  // data = newArr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_toLowerCase",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "newArr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_toUpperCase(s: ref $NativeString) -> ref $NativeString ---
  // ASCII-only: maps a-z (97-122) to A-Z (65-90), copies everything else as-is
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_toUpperCase", funcIdx);

    // params: s(0)
    // locals: len(1), srcData(2), newArr(3), i(4), ch(5), sOff(6)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // srcData = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },

      // newArr = array.new_default(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 3 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },

      // loop
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          { op: "local.get", index: 4 },
          { op: "local.get", index: 1 },
          { op: "i32.ge_u" },
          { op: "br_if", depth: 1 },

          // ch = srcData[sOff + i]
          { op: "local.get", index: 2 },
          { op: "local.get", index: 6 },
          { op: "local.get", index: 4 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 5 },

          // newArr[i] = (ch >= 97 && ch <= 122) ? ch - 32 : ch
          { op: "local.get", index: 3 },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 5 },
          { op: "i32.const", value: 97 },
          { op: "i32.ge_u" },
          { op: "local.get", index: 5 },
          { op: "i32.const", value: 122 },
          { op: "i32.le_u" },
          { op: "i32.and" },
          { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: [
            { op: "local.get", index: 5 },
            { op: "i32.const", value: 32 },
            { op: "i32.sub" },
          ], else: [
            { op: "local.get", index: 5 },
          ]},
          { op: "array.set", typeIdx: strDataTypeIdx },

          // i++
          { op: "local.get", index: 4 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 4 },
          { op: "br", depth: 0 },
        ]},
      ]},

      // return struct.new(len, 0, newArr)
      { op: "local.get", index: 1 },  // len
      { op: "i32.const", value: 0 },  // off = 0
      { op: "local.get", index: 3 },  // data = newArr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_toUpperCase",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "newArr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_replace(s: ref $NativeString, search: ref $NativeString, replacement: ref $NativeString) -> ref $NativeString ---
  // Replaces first occurrence of search with replacement. Pure wasm using indexOf + substring + concat.
  {
    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;

    const typeIdx = addFuncType(ctx, [strRef, strRef, strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_replace", funcIdx);

    // params: s(0), search(1), replacement(2)
    // locals: idx(3), searchLen(4), prefix(5-nullable), suffix(6-nullable)
    const body: Instr[] = [
      // idx = indexOf(s, search, 0)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: indexOfIdx },
      { op: "local.set", index: 3 },

      // if idx == -1, return s unchanged
      { op: "local.get", index: 3 },
      { op: "i32.const", value: -1 },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "val", type: strRef }, then: [
        { op: "local.get", index: 0 },
      ], else: [
        // searchLen = search.len
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 4 },

        // prefix = s.substring(0, idx)
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 3 },
        { op: "call", funcIdx: substringIdx },
        { op: "local.set", index: 5 },

        // suffix = s.substring(idx + searchLen, MAX)
        { op: "local.get", index: 0 },
        { op: "local.get", index: 3 },
        { op: "local.get", index: 4 },
        { op: "i32.add" },
        { op: "i32.const", value: 0x7FFFFFFF },
        { op: "call", funcIdx: substringIdx },
        { op: "local.set", index: 6 },

        // return concat(concat(prefix, replacement), suffix)
        { op: "local.get", index: 5 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: concatIdx },
        { op: "local.get", index: 6 },
        { op: "ref.as_non_null" },
        { op: "call", funcIdx: concatIdx },
      ]},
    ];

    ctx.mod.functions.push({
      name: "__str_replace",
      typeIdx,
      locals: [
        { name: "idx", type: { kind: "i32" } },
        { name: "searchLen", type: { kind: "i32" } },
        { name: "prefix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "suffix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1, 2]),
      exported: false,
    });
  }

  // --- $__str_replaceAll(s: ref $NativeString, search: ref $NativeString, replacement: ref $NativeString) -> ref $NativeString ---
  // Replaces ALL occurrences of search with replacement. Pure wasm loop using indexOf + substring + concat.
  {
    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;

    const typeIdx = addFuncType(ctx, [strRef, strRef, strRef], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_replaceAll", funcIdx);

    // params: s(0), search(1), replacement(2)
    // locals: result(3-nullable), pos(4), idx(5), searchLen(6), prefix(7-nullable)
    const body: Instr[] = [
      // searchLen = search.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 6 },

      // If searchLen == 0, return s unchanged (avoid infinite loop)
      { op: "local.get", index: 6 },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "val", type: strRef }, then: [
        { op: "local.get", index: 0 },
      ], else: [
        // Build an empty result string (len=0, off=0, empty array)
        { op: "i32.const", value: 0 },
        { op: "i32.const", value: 0 },
        { op: "i32.const", value: 0 },
        { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
        { op: "struct.new", typeIdx: strTypeIdx },
        { op: "local.set", index: 3 },

        // pos = 0
        { op: "i32.const", value: 0 },
        { op: "local.set", index: 4 },

        // loop: find next occurrence
        { op: "block", blockType: { kind: "empty" }, body: [
          { op: "loop", blockType: { kind: "empty" }, body: [
            // idx = indexOf(s, search, pos)
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "local.get", index: 4 },
            { op: "call", funcIdx: indexOfIdx },
            { op: "local.set", index: 5 },

            // if idx == -1, break
            { op: "local.get", index: 5 },
            { op: "i32.const", value: -1 },
            { op: "i32.eq" },
            { op: "br_if", labelIdx: 1 },

            // prefix = s.substring(pos, idx)
            { op: "local.get", index: 0 },
            { op: "local.get", index: 4 },
            { op: "local.get", index: 5 },
            { op: "call", funcIdx: substringIdx },
            { op: "local.set", index: 7 },

            // result = concat(result, prefix)
            { op: "local.get", index: 3 },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 7 },
            { op: "ref.as_non_null" },
            { op: "call", funcIdx: concatIdx },

            // result = concat(result, replacement)
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: concatIdx },
            { op: "local.set", index: 3 },

            // pos = idx + searchLen
            { op: "local.get", index: 5 },
            { op: "local.get", index: 6 },
            { op: "i32.add" },
            { op: "local.set", index: 4 },

            // continue loop
            { op: "br", labelIdx: 0 },
          ]},
        ]},

        // Append remainder: result = concat(result, s.substring(pos, MAX))
        { op: "local.get", index: 3 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 4 },
        { op: "i32.const", value: 0x7FFFFFFF },
        { op: "call", funcIdx: substringIdx },
        { op: "ref.as_non_null" },
        { op: "call", funcIdx: concatIdx },
      ]},
    ];

    ctx.mod.functions.push({
      name: "__str_replaceAll",
      typeIdx,
      locals: [
        { name: "result", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "pos", type: { kind: "i32" } },
        { name: "idx", type: { kind: "i32" } },
        { name: "searchLen", type: { kind: "i32" } },
        { name: "prefix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1, 2]),
      exported: false,
    });
  }

  // --- $__str_split(s: ref $NativeString, sep: ref $NativeString) -> ref $vec_nstr ---
  // Splits s by sep, returns a native array of native strings.
  {
    // Register native string array type: (array (mut (ref null $AnyString)))
    // Use ref_null so array.new_default can initialize with null.
    // Key must match what resolveWasmType generates for string[] (ref_N).
    const nstrElemKey = `ref_${anyStrTypeIdx}`;
    const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
    const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
    const nstrVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);
    const nstrVecRef: ValType = { kind: "ref", typeIdx: nstrVecTypeIdx };

    const typeIdx = addFuncType(ctx, [strRef, strRef], [nstrVecRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_split", funcIdx);

    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0), sep(1)
    // locals: sLen(2), sepLen(3), pos(4), idx(5), part(6-nullable),
    //         resultArr(7-nullable), resultLen(8), resultCap(9), newArr(10-nullable)
    const S = 0, SEP = 1;
    const SLEN = 2, SEPLEN = 3, POS = 4, IDX = 5, PART = 6;
    const RARR = 7, RLEN = 8, RCAP = 9, NEWARR = 10;

    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: S },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: SLEN },

      // sepLen = sep.len
      { op: "local.get", index: SEP },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: SEPLEN },

      // resultArr = array.new_default(8)
      { op: "i32.const", value: 8 },
      { op: "array.new_default", typeIdx: nstrArrTypeIdx },
      { op: "local.set", index: RARR },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: RLEN },
      { op: "i32.const", value: 8 },
      { op: "local.set", index: RCAP },

      // pos = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: POS },

      // Handle empty separator: return array with single element (the whole string)
      { op: "local.get", index: SEPLEN },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [
        // For empty sep, split each character (like JS)
        // But for simplicity and correctness, match JS: "abc".split("") => ["a","b","c"]
        // Realloc if needed for sLen elements
        { op: "local.get", index: SLEN },
        { op: "array.new_default", typeIdx: nstrArrTypeIdx },
        { op: "local.set", index: RARR },
        { op: "local.get", index: SLEN },
        { op: "local.set", index: RCAP },

        // Loop: for each character, create a single-char NativeString
        { op: "i32.const", value: 0 },
        { op: "local.set", index: POS },
        { op: "block", blockType: { kind: "empty" }, body: [
          { op: "loop", blockType: { kind: "empty" }, body: [
            { op: "local.get", index: POS },
            { op: "local.get", index: SLEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // part = substring(s, pos, pos+1)
            { op: "local.get", index: S },
            { op: "local.get", index: POS },
            { op: "local.get", index: POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "call", funcIdx: substringIdx },
            { op: "local.set", index: PART },

            // resultArr[pos] = part
            { op: "local.get", index: RARR },
            { op: "local.get", index: POS },
            { op: "local.get", index: PART },
            { op: "array.set", typeIdx: nstrArrTypeIdx },

            { op: "local.get", index: POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: POS },
            { op: "br", depth: 0 },
          ] as Instr[] },
        ] as Instr[] },

        // return struct.new(sLen, resultArr)
        { op: "local.get", index: SLEN },
        { op: "local.get", index: RARR },
        { op: "ref.as_non_null" },
        { op: "struct.new", typeIdx: nstrVecTypeIdx },
        { op: "return" },
      ] as Instr[] },

      // Main split loop: find sep occurrences and extract substrings
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          // idx = indexOf(s, sep, pos)
          { op: "local.get", index: S },
          { op: "local.get", index: SEP },
          { op: "local.get", index: POS },
          { op: "call", funcIdx: indexOfIdx },
          { op: "local.set", index: IDX },

          // if idx == -1: add final part and break
          { op: "local.get", index: IDX },
          { op: "i32.const", value: -1 },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: [
            // part = substring(s, pos, sLen)
            { op: "local.get", index: S },
            { op: "local.get", index: POS },
            { op: "local.get", index: SLEN },
            { op: "call", funcIdx: substringIdx },
            { op: "local.set", index: PART },

            // Grow result if needed
            { op: "local.get", index: RLEN },
            { op: "local.get", index: RCAP },
            { op: "i32.ge_s" },
            { op: "if", blockType: { kind: "empty" }, then: [
              // newCap = cap * 2
              { op: "local.get", index: RCAP },
              { op: "i32.const", value: 2 },
              { op: "i32.mul" },
              { op: "local.set", index: RCAP },
              // newArr = array.new_default(newCap)
              { op: "local.get", index: RCAP },
              { op: "array.new_default", typeIdx: nstrArrTypeIdx },
              { op: "local.set", index: NEWARR },
              // array.copy(newArr, 0, resultArr, 0, resultLen)
              { op: "local.get", index: NEWARR },
              { op: "i32.const", value: 0 },
              { op: "local.get", index: RARR },
              { op: "i32.const", value: 0 },
              { op: "local.get", index: RLEN },
              { op: "array.copy", dstTypeIdx: nstrArrTypeIdx, srcTypeIdx: nstrArrTypeIdx },
              { op: "local.get", index: NEWARR },
              { op: "local.set", index: RARR },
            ] as Instr[] },

            // resultArr[resultLen] = part
            { op: "local.get", index: RARR },
            { op: "local.get", index: RLEN },
            { op: "local.get", index: PART },
            { op: "array.set", typeIdx: nstrArrTypeIdx },
            { op: "local.get", index: RLEN },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: RLEN },

            { op: "br", depth: 2 }, // break outer block
          ] as Instr[] },

          // Found separator: part = substring(s, pos, idx)
          { op: "local.get", index: S },
          { op: "local.get", index: POS },
          { op: "local.get", index: IDX },
          { op: "call", funcIdx: substringIdx },
          { op: "local.set", index: PART },

          // Grow result if needed
          { op: "local.get", index: RLEN },
          { op: "local.get", index: RCAP },
          { op: "i32.ge_s" },
          { op: "if", blockType: { kind: "empty" }, then: [
            { op: "local.get", index: RCAP },
            { op: "i32.const", value: 2 },
            { op: "i32.mul" },
            { op: "local.set", index: RCAP },
            { op: "local.get", index: RCAP },
            { op: "array.new_default", typeIdx: nstrArrTypeIdx },
            { op: "local.set", index: NEWARR },
            { op: "local.get", index: NEWARR },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: RARR },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: RLEN },
            { op: "array.copy", dstTypeIdx: nstrArrTypeIdx, srcTypeIdx: nstrArrTypeIdx },
            { op: "local.get", index: NEWARR },
            { op: "local.set", index: RARR },
          ] as Instr[] },

          // resultArr[resultLen] = part
          { op: "local.get", index: RARR },
          { op: "local.get", index: RLEN },
          { op: "local.get", index: PART },
          { op: "array.set", typeIdx: nstrArrTypeIdx },
          { op: "local.get", index: RLEN },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: RLEN },

          // pos = idx + sepLen
          { op: "local.get", index: IDX },
          { op: "local.get", index: SEPLEN },
          { op: "i32.add" },
          { op: "local.set", index: POS },

          { op: "br", depth: 0 }, // continue loop
        ] as Instr[] },
      ] as Instr[] },

      // return struct.new(resultLen, resultArr)
      { op: "local.get", index: RLEN },
      { op: "local.get", index: RARR },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: nstrVecTypeIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_split",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "sepLen", type: { kind: "i32" } },
        { name: "pos", type: { kind: "i32" } },
        { name: "idx", type: { kind: "i32" } },
        { name: "part", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "resultArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
        { name: "resultLen", type: { kind: "i32" } },
        { name: "resultCap", type: { kind: "i32" } },
        { name: "newArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- Boundary marshaling helpers ---
  // Uses linear memory as a shared buffer for string data transfer.
  // Import registrations are in Step 1 above; here we add the module functions.

  // $__str_to_extern(s: ref $NativeString) -> externref
  // Copies GC array code units to linear memory, then calls __str_from_mem
  {
    const typeIdx = addFuncType(ctx, [strRef], [{ kind: "externref" }]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_to_extern", funcIdx);
    ctx.funcMap.set("__str_to_extern", funcIdx);

    const fromMemIdx = ctx.funcMap.get("__str_from_mem")!;

    // locals: len, i, data, sOff
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 }, // len

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 }, // sOff

      // data = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 3 }, // data

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 }, // i

      // loop: copy code units from GC array to linear memory
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          // if i >= len, break
          { op: "local.get", index: 2 },
          { op: "local.get", index: 1 },
          { op: "i32.ge_u" },
          { op: "br_if", depth: 1 },

          // memory[i*2] = data[sOff + i] (i32.store16)
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 1 },
          { op: "i32.shl" },          // ptr = i * 2
          { op: "local.get", index: 3 },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 2 },
          { op: "i32.add" },          // sOff + i
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "i32.store16", align: 1, offset: 0 },

          // i++
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 2 },
          { op: "br", depth: 0 },
        ]},
      ]},

      // return __str_from_mem(0, len)
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: fromMemIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_to_extern",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "data", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // $__str_from_extern(s: externref) -> ref $NativeString
  // Host writes JS string code units to linear memory, then wasm copies to GC array
  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [strRef]);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.nativeStrHelpers.set("__str_from_extern", funcIdx);
    ctx.funcMap.set("__str_from_extern", funcIdx);

    const toMemIdx = ctx.funcMap.get("__str_to_mem")!;
    const externLenIdx = ctx.funcMap.get("__str_extern_len")!;

    // locals: len, arr, i
    const body: Instr[] = [
      // len = __str_extern_len(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: externLenIdx },
      { op: "local.set", index: 1 }, // len

      // __str_to_mem(s, 0) — host writes code units to linear memory at ptr=0
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: toMemIdx },

      // arr = array.new_default len
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 2 }, // arr

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 }, // i

      // loop: copy from linear memory to GC array
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          // if i >= len, break
          { op: "local.get", index: 3 },
          { op: "local.get", index: 1 },
          { op: "i32.ge_u" },
          { op: "br_if", depth: 1 },

          // arr[i] = memory[i*2] (i32.load16_u)
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 3 },
          { op: "i32.const", value: 1 },
          { op: "i32.shl" },          // ptr = i * 2
          { op: "i32.load16_u", align: 1, offset: 0 },
          { op: "array.set", typeIdx: strDataTypeIdx },

          // i++
          { op: "local.get", index: 3 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 3 },
          { op: "br", depth: 0 },
        ]},
      ]},

      // struct.new(len, 0, arr)
      { op: "local.get", index: 1 },  // len
      { op: "i32.const", value: 0 },  // off = 0
      { op: "local.get", index: 2 },  // data = arr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    ctx.mod.functions.push({
      name: "__str_from_extern",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "arr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }
}

/** Parse a RegExp literal text (e.g. "/\\d+/gi") into pattern and flags */
export function parseRegExpLiteral(text: string): { pattern: string; flags: string } {
  // The text includes the leading '/' and trailing '/flags'.
  // Find the last '/' which separates pattern from flags.
  const lastSlash = text.lastIndexOf("/");
  const pattern = text.slice(1, lastSlash);
  const flags = text.slice(lastSlash + 1);
  return { pattern, flags };
}

/** Scan source for string literals and register env imports for each unique one */
/** Scan source for string literals and register string_constants global imports */
function collectStringLiterals(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const literals = new Set<string>();
  let hasTypeofExpr = false;
  let hasTaggedTemplate = false;

  function visit(node: ts.Node) {
    // Skip computed property names — their string literals are resolved at
    // compile time and never appear as runtime values in the wasm output.
    if (ts.isComputedPropertyName(node)) return;

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
    // Tagged template expressions: collect ALL string parts (including empty strings)
    // because tagged templates pass the full strings array to the tag function.
    // Also collect rawText values for the .raw property on template objects.
    // Register the template vec type early so tag function bodies can access .raw.
    if (ts.isTaggedTemplateExpression(node)) {
      hasTaggedTemplate = true;
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        literals.add(node.template.text);
        const rawText = (node.template as any).rawText;
        if (rawText !== undefined) literals.add(rawText);
      } else if (ts.isTemplateExpression(node.template)) {
        literals.add(node.template.head.text); // include empty strings
        const headRaw = (node.template.head as any).rawText;
        if (headRaw !== undefined) literals.add(headRaw);
        for (const span of node.template.templateSpans) {
          literals.add(span.literal.text); // include empty strings
          const spanRaw = (span.literal as any).rawText;
          if (spanRaw !== undefined) literals.add(spanRaw);
        }
      }
    }
    // RegExp literals: collect pattern and flags as string literals
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const { pattern, flags } = parseRegExpLiteral(node.getText());
      literals.add(pattern);
      if (flags) literals.add(flags);
    }
    // typeof expressions need type-name string constants
    if (ts.isTypeOfExpression(node)) {
      hasTypeofExpr = true;
    }
    // import.meta needs placeholder strings
    if (ts.isMetaProperty(node) &&
        node.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.name.text === "meta") {
      literals.add("module.wasm");
      literals.add("[object Object]");
    }
    ts.forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  ts.forEachChild(sourceFile, visit);

  // typeof expressions may need type-name constants not present in source
  if (hasTypeofExpr) {
    for (const s of ["number", "string", "boolean", "object", "undefined", "function"]) {
      literals.add(s);
    }
  }

  // Register the template vec type early so tag function bodies can use .raw
  if (hasTaggedTemplate) {
    getOrRegisterTemplateVecType(ctx);
  }

  if (literals.size === 0) return;

  if (ctx.fast) {
    // Fast mode: native strings — ensure helpers are emitted, track literals
    // No wasm:js-string or string_constants imports needed
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      // Track literals in stringGlobalMap so compileStringLiteral can find them.
      // Use a sentinel value (-1) since we don't import globals in fast mode.
      if (!ctx.stringGlobalMap.has(value)) {
        ctx.stringGlobalMap.set(value, -1);
      }
    }
    return;
  }

  // Register wasm:js-string imports since we have strings
  addStringImports(ctx);

  // Register a global import from "string_constants" for each unique string literal
  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
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
        if (!ctx.stringGlobalMap.has(prop.name)) literals.add(prop.name);
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (literals.size === 0) return;

  if (ctx.fast) {
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
    }
    return;
  }

  // Ensure wasm:js-string imports exist (may already be registered)
  addStringImports(ctx);

  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
  }
}

/** Register struct field names as string literals for `key in obj` expressions
 *  where the key is a dynamic (non-literal) value. Pre-registers field names
 *  so they can be used for runtime string comparison. */
function collectInExprStringLiterals(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const literals = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      // Only collect for dynamic keys (non-string-literal, non-numeric-literal)
      if (!ts.isStringLiteral(node.left) && !ts.isNumericLiteral(node.left)) {
        const rightType = ctx.checker.getTypeAtLocation(node.right);
        const props = rightType.getProperties();
        for (const prop of props) {
          if (!ctx.stringGlobalMap.has(prop.name)) literals.add(prop.name);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (literals.size === 0) return;

  if (ctx.fast) {
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
    }
    return;
  }

  addStringImports(ctx);
  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
  }
}

/** Register struct field names as string literals for Object.keys() / Object.values() calls.
 *  Detects Object.keys(expr) and Object.values(expr) patterns and pre-registers
 *  the field names from the argument's type as string thunks. */
function collectObjectMethodStringLiterals(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const literals = new Set<string>();
  let hasValues = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      (node.expression.name.text === "keys" || node.expression.name.text === "values" || node.expression.name.text === "entries") &&
      node.arguments.length === 1
    ) {
      if (node.expression.name.text === "values" || node.expression.name.text === "entries") hasValues = true;
      const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      const props = argType.getProperties();
      for (const prop of props) {
        if (!ctx.stringLiteralMap.has(prop.name)) literals.add(prop.name);
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  // Object.values() needs union boxing imports (__box_number etc.)
  // to box primitive field values into externref. Register them now
  // before function indices are assigned in collectDeclarations.
  if (hasValues) {
    addUnionImports(ctx);
  }

  if (literals.size === 0) return;

  if (ctx.fast) {
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
    }
    return;
  }

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
  "exp",
  "log",
  "log2",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "acosh",
  "asinh",
  "atanh",
  "cbrt",
  "expm1",
  "log1p",
]);
const MATH_HOST_METHODS_2ARG = new Set(["pow", "atan2"]);

/** Scan source for Math.xxx() calls that need host imports */
function collectMathImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const needed = new Set<string>();

  let needsToUint32 = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Math"
    ) {
      const method = node.expression.name.text;
      if (
        MATH_HOST_METHODS_1ARG.has(method) ||
        MATH_HOST_METHODS_2ARG.has(method) ||
        method === "random"
      ) {
        needed.add(method);
      }
      // clz32 and imul need __toUint32 for spec-correct ToUint32 conversion
      if (method === "clz32" || method === "imul") {
        needsToUint32 = true;
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

  // Scan all statements (including top-level code compiled into __module_init)
  ts.forEachChild(sourceFile, visit);

  for (const method of needed) {
    if (method === "random") {
      // Math.random requires entropy — must remain a host import
      const typeIdx = addFuncType(ctx, [], [{ kind: "f64" }]);
      addImport(ctx, "env", `Math_${method}`, { kind: "func", typeIdx });
    } else {
      // All other math methods get pure Wasm implementations
      ctx.pendingMathMethods.add(method);
    }
  }

  // Register __toUint32 host import: (f64) → i32
  if (needsToUint32 && !ctx.funcMap.has("__toUint32")) {
    const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "i32" }]);
    addImport(ctx, "env", "__toUint32", { kind: "func", typeIdx });
  }
}

/** Scan source for parseInt / parseFloat / Number() / unary + on strings and register host imports */
function collectParseImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const needed = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const name = node.expression.text;
      if (name === "parseInt" || name === "parseFloat") {
        needed.add(name);
      }
      // Number(x) uses parseFloat for string→number coercion
      if (name === "Number") {
        needed.add("parseFloat");
      }
    }
    // Unary + on string uses parseFloat for coercion (but not for string literals
    // which are statically resolved by tryStaticToNumber)
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.PlusToken &&
      !ts.isStringLiteral(node.operand) &&
      !ts.isNoSubstitutionTemplateLiteral(node.operand)
    ) {
      const operandType = ctx.checker.getTypeAtLocation(node.operand);
      if (operandType.flags & ts.TypeFlags.StringLike) {
        needed.add("parseFloat");
      }
    }
    // Loose equality (== / !=) between string and number/boolean needs parseFloat
    // to coerce the string operand to a number for comparison (#178)
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
          needed.add("parseFloat");
        }
      } catch {
        // Type resolution may fail for some nodes — skip
      }
    }
    ts.forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  ts.forEachChild(sourceFile, visit);

  for (const name of needed) {
    if (name === "parseInt") {
      // (externref, f64) -> f64  — radix is NaN when omitted
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", name, { kind: "func", typeIdx });
    } else {
      // (externref) -> f64
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
      addImport(ctx, "env", name, { kind: "func", typeIdx });
    }
  }
}

/** Known constructors handled natively (not needing __new_ imports) */
const KNOWN_CONSTRUCTORS = new Set([
  "Array", "Date", "Map", "Set", "RegExp", "Error", "TypeError", "RangeError", "Object", "Function",
  "Promise", "WeakMap", "WeakSet", "WeakRef",
  "Number", "String", "Boolean",
]);

/**
 * Scan source for `new X(args...)` where X is not a locally declared class
 * or known extern class, and register `__new_X` host imports so the runtime
 * can provide the constructor.
 */
function collectUnknownConstructorImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  // Map from constructor name to arg count (max seen)
  const needed = new Map<string, number>();

  function visit(node: ts.Node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (!KNOWN_CONSTRUCTORS.has(name)) {
        // Check if it's a class declared in this source file
        const sym = ctx.checker.getSymbolAtLocation(node.expression);
        const decls = sym?.getDeclarations() ?? [];
        const isLocalClass = decls.some(d => {
          if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) return d.getSourceFile() === sourceFile;
          // const Vec2 = class { ... } — variable whose initializer is a class expression
          if (ts.isVariableDeclaration(d) && d.initializer && ts.isClassExpression(d.initializer)) return d.getSourceFile() === sourceFile;
          return false;
        });
        const isExtern = ctx.externClasses.has(name);
        if (!isLocalClass && !isExtern) {
          const argCount = node.arguments?.length ?? 0;
          const prev = needed.get(name) ?? 0;
          needed.set(name, Math.max(prev, argCount));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  for (const [name, argCount] of needed) {
    const importName = `__new_${name}`;
    if (ctx.funcMap.has(importName)) continue;
    const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" } as ValType));
    const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
  }
}

/**
 * Scan source for `new Number(x)`, `new String(x)`, `new Boolean(x)` and
 * register wrapper struct types so that resolveWasmType returns the correct
 * ref type for wrapper-typed variables.
 */
function collectWrapperConstructors(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "Number" || name === "String" || name === "Boolean") {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  if (found) {
    ensureWrapperTypes(ctx);
  }
}

/** Scan source for String.fromCharCode() calls and register host import */
function collectStringStaticImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  let needsFromCharCode = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "String" &&
      node.expression.name.text === "fromCharCode"
    ) {
      needsFromCharCode = true;
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (needsFromCharCode) {
    // (f64) -> externref  (char code -> string)
    const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "String_fromCharCode", { kind: "func", typeIdx });
    if (ctx.fast) {
      ensureNativeStringHelpers(ctx);
    }
  }
}

/** Scan source for Promise.all / Promise.race / Promise.resolve / Promise.reject
 *  calls and `new Promise(...)` constructor usage, and register host imports */
function collectPromiseImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const needed = new Set<string>();
  let needConstructor = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Promise"
    ) {
      const method = node.expression.name.text;
      if (method === "all" || method === "race" || method === "resolve" || method === "reject") {
        needed.add(method);
      }
    }
    // Detect `new Promise(...)`
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Promise"
    ) {
      needConstructor = true;
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
    // Also visit top-level variable declarations and expressions
    if (ts.isVariableStatement(stmt)) {
      visit(stmt);
    }
    if (ts.isExpressionStatement(stmt)) {
      visit(stmt);
    }
    if (ts.isReturnStatement(stmt)) {
      visit(stmt);
    }
  }

  for (const method of needed) {
    const importName = `Promise_${method}`;
    if (!ctx.funcMap.has(importName)) {
      const typeIdx = addFuncType(
        ctx,
        [{ kind: "externref" }],
        [{ kind: "externref" }],
      );
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
    }
  }

  // Register new Promise() constructor import: (externref) -> externref
  if (needConstructor && !ctx.funcMap.has("Promise_new")) {
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "Promise_new", { kind: "func", typeIdx });
  }
}

/** Scan source for JSON.parse / JSON.stringify calls and register host imports */
function collectJsonImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  let needStringify = false;
  let needParse = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "JSON"
    ) {
      const method = node.expression.name.text;
      if (method === "stringify") needStringify = true;
      if (method === "parse") needParse = true;
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (needStringify || needParse) {
    addUnionImports(ctx);
  }
  if (needStringify) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "JSON_stringify", { kind: "func", typeIdx });
  }
  if (needParse) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "JSON_parse", { kind: "func", typeIdx });
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
    if (found) break;
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (found) {
    // __make_callback: (i32, externref) → externref
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "__make_callback", { kind: "func", typeIdx });
  }
}

/** Scan source for generator functions (function*) and register generator host imports */
function collectGeneratorImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  let found = false;

  function visitNode(node: ts.Node): void {
    if (found) return;
    // Generator function declarations: function* foo() { ... }
    if (
      ts.isFunctionDeclaration(node) &&
      node.asteriskToken &&
      node.body &&
      !hasDeclareModifier(node)
    ) {
      found = true;
      return;
    }
    // Generator function expressions: const gen = function*() { ... }
    if (ts.isFunctionExpression(node) && node.asteriskToken) {
      found = true;
      return;
    }
    // Generator class methods: class Foo { *bar() { ... } }
    if (ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      return;
    }
    ts.forEachChild(node, visitNode);
  }

  for (const stmt of sourceFile.statements) {
    visitNode(stmt);
    if (found) break;
  }

  if (found && !ctx.funcMap.has("__gen_create_buffer")) {
    // __gen_create_buffer: () → externref  (creates an empty JS array)
    const bufType = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", "__gen_create_buffer", {
      kind: "func",
      typeIdx: bufType,
    });

    // __gen_push_f64: (externref, f64) → void  (pushes a number to the buffer)
    const pushF64Type = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "f64" }],
      [],
    );
    addImport(ctx, "env", "__gen_push_f64", {
      kind: "func",
      typeIdx: pushF64Type,
    });

    // __gen_push_i32: (externref, i32) → void  (pushes a boolean to the buffer)
    const pushI32Type = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }],
      [],
    );
    addImport(ctx, "env", "__gen_push_i32", {
      kind: "func",
      typeIdx: pushI32Type,
    });

    // __gen_push_ref: (externref, externref) → void  (pushes a string/object to the buffer)
    const pushRefType = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "externref" }],
      [],
    );
    addImport(ctx, "env", "__gen_push_ref", {
      kind: "func",
      typeIdx: pushRefType,
    });

    // __create_generator: (externref) → externref
    // Takes a JS array of yielded values, returns a Generator-like object
    const genType = addFuncType(
      ctx,
      [{ kind: "externref" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "__create_generator", {
      kind: "func",
      typeIdx: genType,
    });

    // __gen_next: (generator: externref) → externref (calls gen.next(), returns IteratorResult)
    addImport(ctx, "env", "__gen_next", {
      kind: "func",
      typeIdx: genType,
    });

    // __gen_result_value: (result: externref) → externref (returns result.value)
    addImport(ctx, "env", "__gen_result_value", {
      kind: "func",
      typeIdx: genType,
    });

    // __gen_result_value_f64: (result: externref) → f64 (returns result.value as number)
    const resultValF64Type = addFuncType(
      ctx,
      [{ kind: "externref" }],
      [{ kind: "f64" }],
    );
    addImport(ctx, "env", "__gen_result_value_f64", {
      kind: "func",
      typeIdx: resultValF64Type,
    });

    // __gen_result_done: (result: externref) → i32 (returns result.done as boolean)
    const resultDoneType = addFuncType(
      ctx,
      [{ kind: "externref" }],
      [{ kind: "i32" }],
    );
    addImport(ctx, "env", "__gen_result_done", {
      kind: "func",
      typeIdx: resultDoneType,
    });
  }
}

/** Functional array methods that need host callback bridges */
const FUNCTIONAL_ARRAY_METHODS = new Set([
  "filter", "map", "reduce", "forEach", "find", "findIndex", "some", "every",
]);

/** Scan source for functional array methods (filter, map, etc.) and register __call_Nf64 imports */
function collectFunctionalArrayImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  let need1 = false;
  let need2 = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (FUNCTIONAL_ARRAY_METHODS.has(method)) {
        if (method === "reduce") {
          need2 = true;
        } else {
          need1 = true;
        }
      }
      // Also detect Array.prototype.METHOD.call(...) pattern
      if (method === "call" && ts.isPropertyAccessExpression(node.expression.expression)) {
        const innerMethod = node.expression.expression.name.text;
        if (FUNCTIONAL_ARRAY_METHODS.has(innerMethod)) {
          if (innerMethod === "reduce") {
            need2 = true;
          } else {
            need1 = true;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (need1) {
    if (ctx.fast) {
      // __call_1_i32: (externref, i32) → i32 — invoke callback with 1 i32 arg (fast mode)
      const typeIdx = addFuncType(
        ctx,
        [{ kind: "externref" }, { kind: "i32" }],
        [{ kind: "i32" }],
      );
      addImport(ctx, "env", "__call_1_i32", { kind: "func", typeIdx });
    } else {
      // __call_1_f64: (externref, f64) → f64 — invoke callback with 1 f64 arg
      const typeIdx = addFuncType(
        ctx,
        [{ kind: "externref" }, { kind: "f64" }],
        [{ kind: "f64" }],
      );
      addImport(ctx, "env", "__call_1_f64", { kind: "func", typeIdx });
    }
  }

  if (need2) {
    if (ctx.fast) {
      // __call_2_i32: (externref, i32, i32) → i32 — invoke callback with 2 i32 args (fast mode)
      const typeIdx = addFuncType(
        ctx,
        [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
        [{ kind: "i32" }],
      );
      addImport(ctx, "env", "__call_2_i32", { kind: "func", typeIdx });
    } else {
      // __call_2_f64: (externref, f64, f64) → f64 — invoke callback with 2 f64 args
      const typeIdx = addFuncType(
        ctx,
        [{ kind: "externref" }, { kind: "f64" }, { kind: "f64" }],
        [{ kind: "f64" }],
      );
      addImport(ctx, "env", "__call_2_f64", { kind: "func", typeIdx });
    }
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
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
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

  // Record the import count before adding, so we can adjust defined-function
  // indices if imports are added after collectDeclarations has run.
  const importsBefore = ctx.numImportFuncs;

  // __typeof_number: (externref) → i32
  const typeofType = addFuncType(
    ctx,
    [{ kind: "externref" }],
    [{ kind: "i32" }],
  );
  addImport(ctx, "env", "__typeof_number", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_string", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_boolean", {
    kind: "func",
    typeIdx: typeofType,
  });

  // __is_truthy: (externref) → i32
  addImport(ctx, "env", "__is_truthy", { kind: "func", typeIdx: typeofType });

  // __unbox_number: (externref) → f64
  const unboxNumType = addFuncType(
    ctx,
    [{ kind: "externref" }],
    [{ kind: "f64" }],
  );
  addImport(ctx, "env", "__unbox_number", {
    kind: "func",
    typeIdx: unboxNumType,
  });

  // __unbox_boolean: (externref) → i32
  addImport(ctx, "env", "__unbox_boolean", {
    kind: "func",
    typeIdx: typeofType,
  });

  // __box_number: (f64) → externref
  const boxNumType = addFuncType(
    ctx,
    [{ kind: "f64" }],
    [{ kind: "externref" }],
  );
  addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxNumType });

  // __box_boolean: (i32) → externref
  const boxBoolType = addFuncType(
    ctx,
    [{ kind: "i32" }],
    [{ kind: "externref" }],
  );
  addImport(ctx, "env", "__box_boolean", {
    kind: "func",
    typeIdx: boxBoolType,
  });

  // __typeof: (externref) → externref (returns type string)
  const typeofStrType = addFuncType(
    ctx,
    [{ kind: "externref" }],
    [{ kind: "externref" }],
  );
  addImport(ctx, "env", "__typeof", {
    kind: "func",
    typeIdx: typeofStrType,
  });

  // If imports were added after defined functions were registered (late addition),
  // shift all defined-function indices and fix exports/funcMap/call instructions.
  // The new imports themselves (at indices importsBefore..numImportFuncs-1) are already
  // correct, so we only shift indices that were >= importsBefore BEFORE the addition,
  // i.e., the defined functions that start at index importsBefore in the old scheme.
  const delta = ctx.numImportFuncs - importsBefore;
  if (delta > 0 && ctx.mod.functions.length > 0) {
    // Build a set of the new import names to skip them during funcMap update
    const newImportNames = new Set([
      "__typeof_number", "__typeof_string", "__typeof_boolean",
      "__is_truthy", "__unbox_number", "__unbox_boolean",
      "__box_number", "__box_boolean", "__typeof",
    ]);
    // Update funcMap entries for defined functions (not imports)
    for (const [name, idx] of ctx.funcMap) {
      if (!newImportNames.has(name) && idx >= importsBefore) {
        ctx.funcMap.set(name, idx + delta);
      }
    }
    // Update export indices
    for (const exp of ctx.mod.exports) {
      if (exp.desc.kind === "func" && exp.desc.index >= importsBefore) {
        exp.desc.index += delta;
      }
    }
    // Update call instructions in already-compiled function bodies (recursive)
    function shiftFuncIndices(instrs: Instr[]): void {
      for (const instr of instrs) {
        if (instr.op === "call" && instr.funcIdx >= importsBefore) {
          instr.funcIdx += delta;
        }
        if (instr.op === "ref.func" && instr.funcIdx >= importsBefore) {
          instr.funcIdx += delta;
        }
        // Recurse into nested instruction arrays
        if ("body" in instr && Array.isArray((instr as any).body)) {
          shiftFuncIndices((instr as any).body);
        }
        if ("then" in instr && Array.isArray((instr as any).then)) {
          shiftFuncIndices((instr as any).then);
        }
        if ("else" in instr && Array.isArray((instr as any).else)) {
          shiftFuncIndices((instr as any).else);
        }
        if ("catches" in instr && Array.isArray((instr as any).catches)) {
          for (const c of (instr as any).catches) {
            if (Array.isArray(c.body)) shiftFuncIndices(c.body);
          }
        }
        if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
          shiftFuncIndices((instr as any).catchAll);
        }
      }
    }
    for (const func of ctx.mod.functions) {
      shiftFuncIndices(func.body);
    }
    // Also shift indices in the currently-being-compiled function body,
    // which may differ from func.body (fctx.body starts as [] and is
    // assigned to func.body only after compilation completes).
    if (ctx.currentFunc) {
      // Check that we don't double-shift (fctx.body won't be in
      // ctx.mod.functions until func.body = fctx.body runs later).
      const curBody = ctx.currentFunc.body;
      const alreadyShifted = ctx.mod.functions.some(f => f.body === curBody);
      if (!alreadyShifted) {
        shiftFuncIndices(curBody);
      }
      // Also shift any saved body arrays (from savedBody swap pattern).
      // When fctx.body is swapped to a fresh [] for inner block compilation,
      // the outer body (savedBody) is pushed onto this stack. Without shifting
      // these, call/ref.func indices in the outer body become stale.
      for (const sb of ctx.currentFunc.savedBodies) {
        // Skip if this is the same array as curBody (would double-shift)
        if (sb === curBody) continue;
        // Skip if already in mod.functions (would double-shift)
        if (ctx.mod.functions.some(f => f.body === sb)) continue;
        shiftFuncIndices(sb);
      }
    }
    // Update table elements
    for (const elem of ctx.mod.elements) {
      if (elem.funcIndices) {
        for (let i = 0; i < elem.funcIndices.length; i++) {
          if (elem.funcIndices[i]! >= importsBefore) {
            elem.funcIndices[i]! += delta;
          }
        }
      }
    }
    // Update declaredFuncRefs
    if (ctx.mod.declaredFuncRefs.length > 0) {
      ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map(
        idx => idx >= importsBefore ? idx + delta : idx,
      );
    }
  }
}

/**
 * Scan source for for...of on non-array types (strings, externref iterables)
 * and register the host-delegated iterator protocol imports.
 */
function collectIteratorImports(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isForOfStatement(node)) {
      const exprType = ctx.checker.getTypeAtLocation(node.expression);
      // Array types use the existing index-based loop — no iterator imports needed
      const sym =
        (exprType as ts.TypeReference).symbol ?? (exprType as ts.Type).symbol;
      if (sym?.name !== "Array") {
        // In fast mode, strings are iterated natively — no iterator imports needed
        if (ctx.fast && ctx.anyStrTypeIdx >= 0 && isStringType(exprType)) {
          return;
        }
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (found) break;
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (found) break;
        if (
          (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) &&
          member.body
        ) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    } else if (ts.isForOfStatement(stmt)) {
      visit(stmt);
    }
  }

  if (found) {
    addIteratorImports(ctx);
  }
}

/** Register the iterator protocol host imports if not already registered */
export function addIteratorImports(ctx: CodegenContext): void {
  // Guard: only register once
  if (ctx.funcMap.has("__iterator")) return;

  // __iterator: (externref) → externref — calls obj[Symbol.iterator]()
  const extToExt = addFuncType(
    ctx,
    [{ kind: "externref" }],
    [{ kind: "externref" }],
  );
  addImport(ctx, "env", "__iterator", { kind: "func", typeIdx: extToExt });

  // __iterator_next: (externref) → externref — calls iter.next()
  addImport(ctx, "env", "__iterator_next", {
    kind: "func",
    typeIdx: extToExt,
  });

  // __iterator_done: (externref) → i32 — returns result.done ? 1 : 0
  const extToI32 = addFuncType(
    ctx,
    [{ kind: "externref" }],
    [{ kind: "i32" }],
  );
  addImport(ctx, "env", "__iterator_done", {
    kind: "func",
    typeIdx: extToI32,
  });

  // __iterator_value: (externref) → externref — returns result.value
  addImport(ctx, "env", "__iterator_value", {
    kind: "func",
    typeIdx: extToExt,
  });
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
  if (desc.kind === "global") {
    ctx.numImportGlobals++;
  }
}

/**
 * Register a string literal as a global import from the "string_constants" namespace.
 * Uses importedStringConstants: the import name is the literal string value itself,
 * and the global type is (ref extern) (non-nullable externref).
 */
export function addStringConstantGlobal(ctx: CodegenContext, value: string): void {
  if (ctx.stringGlobalMap.has(value)) return; // already registered

  // If module-defined globals already exist, adding a new import global
  // shifts their absolute indices by 1. Fix up all existing instructions.
  const hasModuleGlobals = ctx.mod.globals.length > 0 || ctx.mod.functions.length > 0;
  const oldNumImportGlobals = ctx.numImportGlobals;

  const globalIdx = ctx.numImportGlobals; // next global import index
  addImport(ctx, "string_constants", value, {
    kind: "global",
    type: { kind: "externref" },
    mutable: false,
  });
  ctx.stringGlobalMap.set(value, globalIdx);
  ctx.stringLiteralMap.set(value, `__str_${ctx.stringLiteralCounter}`);
  ctx.stringLiteralValues.set(`__str_${ctx.stringLiteralCounter}`, value);
  ctx.stringLiteralCounter++;
  ctx.mod.stringPool.push(value);

  // Fix up global indices in already-compiled function bodies and the
  // current function being compiled. Any global.get/global.set with
  // index >= oldNumImportGlobals was referencing a module-defined global
  // and must be shifted by +1 since we just inserted a new import global.
  if (hasModuleGlobals) {
    fixupModuleGlobalIndices(ctx, oldNumImportGlobals, 1);
  }
}

/** Return the absolute Wasm global index for a new module-defined global. */
export function nextModuleGlobalIdx(ctx: CodegenContext): number {
  return ctx.numImportGlobals + ctx.mod.globals.length;
}

/** Convert an absolute Wasm global index to a local module-globals array index. */
export function localGlobalIdx(ctx: CodegenContext, absIdx: number): number {
  return absIdx - ctx.numImportGlobals;
}

/**
 * Fix up module-global absolute indices in all compiled function bodies.
 * When addStringConstantGlobal is called during codegen (e.g. from emitBoolToString
 * or function .name access), numImportGlobals increases, shifting the absolute
 * indices of all module-defined globals. This function walks all instructions
 * and adjusts global.get/global.set indices that reference module globals.
 *
 * @param ctx - codegen context
 * @param threshold - the numImportGlobals value at the time module globals were allocated
 * @param delta - how many new import globals were added (shift amount)
 */
function fixupModuleGlobalIndices(
  ctx: CodegenContext,
  threshold: number,
  delta: number,
): void {
  function shiftGlobalIndices(instrs: Instr[]): void {
    for (const instr of instrs) {
      if (
        (instr.op === "global.get" || instr.op === "global.set") &&
        instr.index >= threshold
      ) {
        instr.index += delta;
      }
      // Recurse into nested instruction arrays (if/else/block/loop)
      if ("body" in instr && Array.isArray((instr as any).body)) {
        shiftGlobalIndices((instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        shiftGlobalIndices((instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        shiftGlobalIndices((instr as any).else);
      }
    }
  }

  for (const func of ctx.mod.functions) {
    shiftGlobalIndices(func.body);
  }

  // Also fix up the current function being compiled (its body is not yet
  // in ctx.mod.functions — it's in the FunctionContext's body array)
  if (ctx.currentFunc) {
    shiftGlobalIndices(ctx.currentFunc.body);
  }

  // Also fix up the pending module-init body (compiled but not yet in ctx.mod.functions)
  if (ctx.pendingInitBody) {
    shiftGlobalIndices(ctx.pendingInitBody);
  }

  // Also fix up global init expressions (e.g. globals that reference other globals)
  for (const g of ctx.mod.globals) {
    if (g.init) shiftGlobalIndices(g.init);
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
export function getOrRegisterArrayType(
  ctx: CodegenContext,
  elemKind: string,
  elemTypeOverride?: ValType,
): number {
  if (ctx.arrayTypeMap.has(elemKind)) return ctx.arrayTypeMap.get(elemKind)!;
  const elemType: ValType =
    elemTypeOverride ??
    (elemKind === "f64"
      ? { kind: "f64" }
      : elemKind === "i32"
        ? { kind: "i32" }
        : { kind: "externref" });
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
      {
        name: "data",
        type: { kind: "ref", typeIdx: arrTypeIdx },
        mutable: true,
      },
    ],
  });
  ctx.vecTypeMap.set(elemKind, vecIdx);
  return vecIdx;
}

/**
 * Get or register the template vec struct type for tagged template string arrays.
 * This is a vec struct with an additional `raw` field pointing to another vec:
 *   (struct (field $length (mut i32)) (field $data (ref $arr)) (field $raw (ref_null $vec)))
 *
 * The `raw` field holds the unprocessed (raw) template strings.
 */
export function getOrRegisterTemplateVecType(ctx: CodegenContext): number {
  if (ctx.templateVecTypeIdx >= 0) return ctx.templateVecTypeIdx;

  // Ensure the base vec type for externref exists
  const baseVecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, baseVecTypeIdx);

  // Mark the base vec struct as non-final so template vec can subtype it
  const baseVecDef = ctx.mod.types[baseVecTypeIdx];
  if (baseVecDef && baseVecDef.kind === "struct" && baseVecDef.superTypeIdx === undefined) {
    baseVecDef.superTypeIdx = -1; // non-final root
  }

  // Register template vec as subtype of base vec: { length: i32, data: ref $arr, raw: ref_null $vec }
  const templateVecIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__template_vec_externref",
    superTypeIdx: baseVecTypeIdx,
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      {
        name: "data",
        type: { kind: "ref", typeIdx: arrTypeIdx },
        mutable: true,
      },
      {
        name: "raw",
        type: { kind: "ref_null", typeIdx: baseVecTypeIdx },
        mutable: false,
      },
    ],
  });
  ctx.templateVecTypeIdx = templateVecIdx;
  return templateVecIdx;
}

/**
 * Get or register a ref cell struct type for mutable closure captures.
 * A ref cell is a 1-field mutable struct: (struct (field $value (mut T)))
 */
export function getOrRegisterRefCellType(
  ctx: CodegenContext,
  valType: ValType,
): number {
  const key =
    (valType.kind === "ref" || valType.kind === "ref_null")
      ? `${valType.kind}_${(valType as { typeIdx: number }).typeIdx}`
      : valType.kind;
  const existing = ctx.refCellTypeMap.get(key);
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `__ref_cell_${key}`,
    fields: [
      { name: "value", type: valType, mutable: true },
    ],
  });
  ctx.refCellTypeMap.set(key, typeIdx);
  return typeIdx;
}

/** Get the raw array type index from a vec struct type index. */
export function getArrTypeIdxFromVec(
  ctx: CodegenContext,
  vecTypeIdx: number,
): number {
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") return -1;
  const dataField = vecDef.fields[1];
  if (!dataField) return -1;
  // data field may use ref_null instead of ref (e.g. for nullable element types)
  if (dataField.type.kind !== "ref" && dataField.type.kind !== "ref_null") {
    return -1;
  }
  return (dataField.type as { typeIdx: number }).typeIdx;
}

/**
 * Check if a ts.Type is a TypeScript tuple type (e.g. [number, string]).
 * Tuples are TypeReference types whose target has the Tuple object flag.
 * The Tuple flag is on the target, not the reference itself.
 */
export function isTupleType(type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  const objType = type as ts.ObjectType;
  // Direct Tuple flag check (on the target for TypeReference types)
  if ((objType.objectFlags & ts.ObjectFlags.Tuple) !== 0) return true;
  // TypeReference → check target's objectFlags
  if ((objType.objectFlags & ts.ObjectFlags.Reference) !== 0) {
    const ref = type as ts.TypeReference;
    if (ref.target && (ref.target.objectFlags & ts.ObjectFlags.Tuple) !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Get the element types of a tuple type.
 * Returns the resolved ValType for each element position.
 */
export function getTupleElementTypes(
  ctx: CodegenContext,
  tsType: ts.Type,
): ValType[] {
  const typeRef = tsType as ts.TypeReference;
  const typeArgs = ctx.checker.getTypeArguments(typeRef);
  return typeArgs.map((t) => resolveWasmType(ctx, t));
}

/**
 * Build a unique key for a tuple type signature based on its element types.
 * Used as the key for tupleTypeMap to de-duplicate identical tuple shapes.
 */
function tupleTypeKey(elemTypes: ValType[]): string {
  return elemTypes
    .map((t) => {
      if (t.kind === "ref" || t.kind === "ref_null") return `${t.kind}_${t.typeIdx}`;
      return t.kind;
    })
    .join(",");
}

/**
 * Get or register a Wasm GC struct type for a tuple type.
 * Each unique tuple signature (e.g. [f64, externref]) maps to one struct type
 * with fields named _0, _1, etc.
 */
export function getOrRegisterTupleType(
  ctx: CodegenContext,
  elemTypes: ValType[],
): number {
  const key = tupleTypeKey(elemTypes);
  const existing = ctx.tupleTypeMap.get(key);
  if (existing !== undefined) return existing;

  const fields: FieldDef[] = elemTypes.map((t, i) => ({
    name: `_${i}`,
    type: t,
    mutable: false,
  }));

  const typeIdx = ctx.mod.types.length;
  const structName = `__tuple_${ctx.tupleTypeMap.size}`;
  ctx.mod.types.push({
    kind: "struct",
    name: structName,
    fields,
  } as StructTypeDef);
  ctx.tupleTypeMap.set(key, typeIdx);
  return typeIdx;
}

/**
 * Resolve a ts.Type to a ValType, using the struct registry and anonymous type map.
 * Use this instead of mapTsTypeToWasm in the codegen to get real type indices.
 */
export function resolveWasmType(ctx: CodegenContext, tsType: ts.Type): ValType {
  // Fast mode: string → ref $AnyString (not externref)
  if (ctx.fast && ctx.anyStrTypeIdx >= 0 && isStringType(tsType)) {
    return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  }

  // Check tuple types BEFORE Array — tuples have the Object flag and Array symbol
  // but should be compiled to structs, not arrays
  if (isTupleType(tsType)) {
    const elemTypes = getTupleElementTypes(ctx, tsType);
    const tupleIdx = getOrRegisterTupleType(ctx, elemTypes);
    return { kind: "ref", typeIdx: tupleIdx };
  }

  // Check Array<T> / T[] BEFORE isExternalDeclaredClass, because Array is declared
  // in the lib as `declare var Array: ArrayConstructor` which would match externref
  if (tsType.flags & ts.TypeFlags.Object) {
    const sym =
      (tsType as ts.TypeReference).symbol ?? (tsType as ts.Type).symbol;
    if (sym?.name === "Array") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      const elemTsType = typeArgs[0];
      const elemWasm: ValType = elemTsType
        ? resolveWasmType(ctx, elemTsType)
        : { kind: "externref" };
      const elemKey =
        elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
          ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
          : elemWasm.kind;
      const vecIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
      // Use ref_null so locals can default-initialize to null
      return { kind: "ref_null", typeIdx: vecIdx };
    }

    // Wrapper types (Number, String, Boolean) — map to primitives directly.
    // new Number(x), new String(x), new Boolean(x) return primitives, not object wrappers.
    if (sym?.name === "Number" && (tsType.flags & ts.TypeFlags.Object)) {
      return { kind: "f64" };
    }
    if (sym?.name === "String" && (tsType.flags & ts.TypeFlags.Object)) {
      return ctx.fast ? nativeStringType(ctx) : { kind: "externref" };
    }
    if (sym?.name === "Boolean" && (tsType.flags & ts.TypeFlags.Object)) {
      return { kind: "i32" };
    }

    // Promise<T> → unwrap to T.
    // Async functions are compiled synchronously, so Promise<T> is just T at the Wasm level.
    if (sym?.name === "Promise") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      if (typeArgs.length > 0) {
        const inner = typeArgs[0]!;
        if (isVoidType(inner)) return { kind: "externref" }; // Promise<void> → externref (no value)
        return resolveWasmType(ctx, inner);
      }
      return { kind: "externref" }; // bare Promise without type arg
    }

    // Check externref AFTER Array check — Array is declared in lib but should use wasm GC arrays
    if (isExternalDeclaredClass(tsType, ctx.checker))
      return { kind: "externref" };

    let name = sym?.name;
    // Map class expression symbol names to their synthetic names
    if (name && !ctx.structMap.has(name)) {
      name = ctx.classExprNameMap.get(name) ?? name;
    }
    // Check named structs (interfaces, type aliases)
    if (
      name &&
      name !== "__type" &&
      name !== "__object" &&
      ctx.structMap.has(name)
    ) {
      return { kind: "ref", typeIdx: ctx.structMap.get(name)! };
    }
    // Check anonymous type registry
    const anonName = ctx.anonTypeMap.get(tsType);
    if (anonName && ctx.structMap.has(anonName)) {
      return { kind: "ref", typeIdx: ctx.structMap.get(anonName)! };
    }

    // Auto-register anonymous object types that look like plain data objects
    // (name is __type or __object, has properties, not a class/function/external type)
    if (
      !anonName &&
      (name === "__type" || name === "__object") &&
      tsType.getProperties().length > 0
    ) {
      ensureStructForType(ctx, tsType);
      const registeredName = ctx.anonTypeMap.get(tsType);
      if (registeredName && ctx.structMap.has(registeredName)) {
        return { kind: "ref", typeIdx: ctx.structMap.get(registeredName)! };
      }
    }
  }

  // Handle unions (T | undefined) — resolve inner type
  if (tsType.isUnion()) {
    const nonNullish = tsType.types.filter(
      (t) =>
        !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined),
    );
    if (nonNullish.length === 1 && tsType.types.length === 2) {
      const inner = resolveWasmType(ctx, nonNullish[0]!);
      if (inner.kind === "ref")
        return { kind: "ref_null", typeIdx: inner.typeIdx };
      return inner;
    }
  }

  // any/unknown → ref_null $AnyValue (boxed any) when available.
  // Only in fast mode where there are no host-imported extern classes to conflict with.
  // In non-fast mode, any/unknown falls through to mapTsTypeToWasm → externref.
  if (
    ctx.fast &&
    (tsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
  ) {
    ensureAnyValueType(ctx);
    return { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
  }

  return mapTsTypeToWasm(tsType, ctx.checker, ctx.fast);
}

/**
 * Ensure a ts.Type that's an object type is registered as a struct.
 * For named types already in structMap, this is a no-op.
 * For anonymous types, auto-registers them with a generated name.
 */
export function ensureStructForType(ctx: CodegenContext, tsType: ts.Type): void {
  if (!(tsType.flags & ts.TypeFlags.Object)) return;
  if (isExternalDeclaredClass(tsType, ctx.checker)) return;
  // Tuple types are handled by getOrRegisterTupleType, not as anonymous structs
  if (isTupleType(tsType)) return;
  // Callable types (functions) are compiled as closures, not structs
  if (tsType.getCallSignatures().length > 0) return;

  const name = tsType.symbol?.name;

  // Already registered as named struct
  if (
    name &&
    name !== "__type" &&
    name !== "__object" &&
    ctx.structMap.has(name)
  )
    return;

  // Already registered as anonymous struct
  if (ctx.anonTypeMap.has(tsType)) return;

  // Get properties from the type (empty objects get an empty struct)
  const props = tsType.getProperties();

  const fields: FieldDef[] = [];
  for (const prop of props) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    // Recursively register nested object types as structs before resolving
    ensureStructForType(ctx, propType);
    // Use resolveWasmType so nested structs get ref types, not externref
    let wasmType = resolveWasmType(ctx, propType);
    // For valueOf/toString callable properties, store as eqref instead of externref
    // so coercion can recover the closure and call it via call_ref
    if (wasmType.kind === "externref" && propType.getCallSignatures().length > 0 &&
        (prop.name === "valueOf" || prop.name === "toString")) {
      wasmType = { kind: "eqref" };
    }
    fields.push({ name: prop.name, type: wasmType, mutable: true });
  }

  // Structural dedup: check if an existing anonymous struct has the exact same fields.
  // This avoids creating duplicate struct types for the same shape when TS returns
  // different ts.Type objects (e.g. variable type vs. initializer type).
  for (const [existingName, existingFields] of ctx.structFields) {
    if (!existingName.startsWith("__anon_")) continue;
    if (existingFields.length !== fields.length) continue;
    const match = existingFields.every((ef, i) => {
      const nf = fields[i]!;
      if (ef.name !== nf.name || ef.type.kind !== nf.type.kind) return false;
      if ((ef.type.kind === "ref" || ef.type.kind === "ref_null") &&
          (ef.type as { typeIdx: number }).typeIdx !== (nf.type as { typeIdx: number }).typeIdx) return false;
      return true;
    });
    if (match) {
      ctx.anonTypeMap.set(tsType, existingName);
      return;
    }
  }

  const structName = `__anon_${ctx.anonTypeCounter++}`;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: structName,
    fields,
  } as StructTypeDef);
  ctx.structMap.set(structName, typeIdx);
  ctx.structFields.set(structName, fields);
  ctx.anonTypeMap.set(tsType, structName);

  // Pre-register placeholder functions for callable properties (methods).
  // This ensures that struct method calls (e.g. obj.foo()) can resolve
  // the function index during the first pass, before the object literal's
  // method bodies are compiled in compileObjectLiteralForStruct.
  for (const prop of props) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const callSigs = propType.getCallSignatures();
    if (callSigs.length === 0) continue;

    // Only pre-register methods that have a user-defined declaration
    // (MethodDeclaration or PropertyAssignment with function initializer in user code).
    // Skip inherited/prototype methods (toString, valueOf from Object.prototype)
    // and lib type method signatures, as they won't have a body to compile
    // in compileObjectLiteralForStruct.
    const decl = prop.valueDeclaration;
    if (!decl) continue;
    const isUserMethod = ts.isMethodDeclaration(decl) ||
      (ts.isPropertyAssignment(decl) && (ts.isFunctionExpression(decl.initializer) || ts.isArrowFunction(decl.initializer)));
    if (!isUserMethod) continue;
    // Also skip declarations from .d.ts files (lib types)
    const declSourceFile = decl.getSourceFile();
    if (declSourceFile && declSourceFile.isDeclarationFile) continue;

    const fullName = `${structName}_${prop.name}`;
    if (ctx.funcMap.has(fullName)) continue; // already registered

    const sig = callSigs[0]!;
    // Build parameter types: self (ref $structTypeIdx) + declared params
    const methodParams: ValType[] = [{ kind: "ref", typeIdx }];
    for (const param of sig.parameters) {
      const paramDecl = param.valueDeclaration;
      if (paramDecl) {
        const pt = ctx.checker.getTypeAtLocation(paramDecl);
        methodParams.push(resolveWasmType(ctx, pt));
      } else {
        methodParams.push({ kind: "f64" });
      }
    }
    // Check if this is a generator method (*method() { ... })
    const isGenMethod = ts.isMethodDeclaration(decl) && decl.asteriskToken !== undefined;
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    const methodResults: ValType[] = isGenMethod
      ? [{ kind: "externref" }]
      : (retType && !isVoidType(retType)
        ? [resolveWasmType(ctx, retType)]
        : []);

    const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);
    const methodFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set(fullName, methodFuncIdx);

    const methodFunc: WasmFunction = {
      name: fullName,
      typeIdx: methodTypeIdx,
      locals: [],
      body: [],
      exported: false,
    };
    ctx.mod.functions.push(methodFunc);
  }
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
            "Array",
            "Number",
            "Boolean",
            "String",
            "Object",
            "Function",
            "Symbol",
            "BigInt",
            "Int8Array",
            "Uint8Array",
            "Int16Array",
            "Uint16Array",
            "Int32Array",
            "Uint32Array",
            "Float32Array",
            "Float64Array",
            "ArrayBuffer",
            "DataView",
            "JSON",
            "Math",
            "Error",
            "TypeError",
            "RangeError",
            "SyntaxError",
            "URIError",
            "EvalError",
            "ReferenceError",
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
  if (ERROR_TYPES_SKIP.has(className)) return;
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

/** Error types handled natively — skip extern class registration */
const ERROR_TYPES_SKIP = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError",
  "URIError", "EvalError", "ReferenceError",
]);

/** Collect extern class info from a `declare var X: { prototype: X; new(): X }` (lib.dom.d.ts pattern) */
function collectExternFromDeclareVar(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
): void {
  const className = (decl.name as ts.Identifier).text;
  if (ERROR_TYPES_SKIP.has(className)) return;
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
            info.constructorParams.push(
              mapTsTypeToWasm(paramType, ctx.checker),
            );
          }
          break;
        }
      }
    } else if (ts.isTypeReferenceNode(decl.type)) {
      // Resolve interface reference (e.g. DateConstructor, RegExpConstructor)
      const refType = ctx.checker.getTypeAtLocation(decl.type);
      const constructSigs = refType.getConstructSignatures();
      // Use the constructor with the most parameters so all overloads can be
      // served.  Missing args at call sites are padded with defaults.
      const sig = constructSigs.length > 0
        ? constructSigs.reduce((a, b) =>
            b.parameters.length > a.parameters.length ? b : a)
        : undefined;
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
    if (
      ts.isMethodSignature(member) &&
      member.name &&
      ts.isIdentifier(member.name)
    ) {
      const methodName = member.name.text;
      if (info.methods.has(methodName)) continue;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      if (sig) {
        const params: ValType[] = [{ kind: "externref" }];
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
    // Property signatures
    if (
      ts.isPropertySignature(member) &&
      member.name &&
      ts.isIdentifier(member.name)
    ) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
      const isReadonly =
        member.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword,
        ) ?? false;
      info.properties.set(propName, { type: wasmType, readonly: isReadonly });
    }
    // Getter accessors (e.g. `get style(): CSSStyleDeclaration`)
    if (
      ts.isGetAccessorDeclaration(member) &&
      member.name &&
      ts.isIdentifier(member.name)
    ) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
      // Check if there's a matching setter
      const hasSetter = iface.members.some(
        (m) =>
          ts.isSetAccessorDeclaration(m) &&
          ts.isIdentifier(m.name) &&
          m.name.text === propName,
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
  const ctorTypeIdx = addFuncType(ctx, info.constructorParams, [
    { kind: "externref" },
  ]);
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
        if (info)
          register(`${info.importPrefix}_new`, info.constructorParams, [
            { kind: "externref" },
          ]);
      }
    }

    // RegExp literal (/pattern/flags) → needs RegExp_new import
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const info = ctx.externClasses.get("RegExp");
      if (info) {
        register(`${info.importPrefix}_new`, info.constructorParams, [
          { kind: "externref" },
        ]);
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
              register(
                `${info.importPrefix}_${memberName}`,
                sig.params,
                sig.results,
              );
            }
          } else {
            const info = resolveExtern(className, memberName, "property");
            if (info) {
              const propInfo = info.properties.get(memberName)!;
              register(
                `${info.importPrefix}_get_${memberName}`,
                [{ kind: "externref" }],
                [propInfo.type],
              );
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
          register(
            `${info.importPrefix}_set_${propName}`,
            [{ kind: "externref" }, propInfo.type],
            [],
          );
        }
      }
    }

    // obj[idx] on externref (e.g. HTMLCollection) → __extern_get
    if (ts.isElementAccessExpression(node)) {
      // Skip when element access is the callee of a call expression (e.g. obj['method']())
      // — the call handler compiles this as a direct method call, not a property read
      const isCallCallee = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node;
      const objType = ctx.checker.getTypeAtLocation(node.expression);
      const sym = objType.getSymbol();
      // Skip Array and tuple types — those use Wasm GC struct/array ops, not host import
      // Skip widened empty objects — those use struct.get, not host import
      const isWidenedVar = ts.isIdentifier(node.expression) && ctx.widenedVarStructMap.has(node.expression.text);
      if (!isCallCallee && sym?.name !== "Array" && sym?.name !== "__type" && sym?.name !== "__object" && !isTupleType(objType) && !isWidenedVar) {
        const wasmType = mapTsTypeToWasm(objType, ctx.checker);
        if (wasmType.kind === "externref") {
          register(
            "__extern_get",
            [{ kind: "externref" }, { kind: "externref" }],
            [{ kind: "externref" }],
          );
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
  "document",
  "window",
  "Date",
  "Map",
  "Set",
  "RegExp",
  "Error",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
]);

function sourceUsesLibGlobals(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && LIB_GLOBALS.has(node.text)) {
      found = true;
      return;
    }
    // RegExp literals (/pattern/flags) implicitly use the RegExp extern class
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
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

/** Collect enum declarations into ctx.enumValues / ctx.enumStringValues */
function collectEnumDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  const stringEnumLiterals: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isEnumDeclaration(stmt)) continue;
    const enumName = stmt.name.text;
    let nextValue = 0;
    for (const member of stmt.members) {
      const memberName = (member.name as ts.Identifier).text;
      const key = `${enumName}.${memberName}`;
      if (member.initializer) {
        if (ts.isStringLiteral(member.initializer)) {
          // String enum member — store in enumStringValues
          const strVal = member.initializer.text;
          ctx.enumStringValues.set(key, strVal);
          if (!ctx.stringGlobalMap.has(strVal)) {
            stringEnumLiterals.push(strVal);
          }
          continue;
        }
        if (ts.isNumericLiteral(member.initializer)) {
          nextValue = Number(member.initializer.text.replace(/_/g, ""));
        } else if (
          ts.isPrefixUnaryExpression(member.initializer) &&
          member.initializer.operator === ts.SyntaxKind.MinusToken &&
          ts.isNumericLiteral(member.initializer.operand)
        ) {
          nextValue = -Number(
            (member.initializer.operand as ts.NumericLiteral).text.replace(/_/g, ""),
          );
        }
      }
      ctx.enumValues.set(key, nextValue);
      nextValue++;
    }
  }

  // Register string enum literals as string constant globals
  if (stringEnumLiterals.length > 0) {
    if (ctx.fast) {
      ensureNativeStringHelpers(ctx);
      for (const value of stringEnumLiterals) {
        if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
      }
    } else {
      addStringImports(ctx);
      for (const value of stringEnumLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }
}

/**
 * Resolve a class member's PropertyName to a static string.
 * Handles identifiers, private identifiers, string literals, numeric literals,
 * and computed property names that can be evaluated at compile time.
 */
function resolveClassMemberName(ctx: CodegenContext, name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text.slice(1);
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    return resolveComputedKeyExpression(ctx, name.expression);
  }
  return undefined;
}

/** Collect all function declarations and interfaces */
/** Collect a class declaration or class expression: register struct type, constructor, and methods */
export function collectClassDeclaration(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  syntheticName?: string,
): void {
  const className = syntheticName ?? decl.name!.text;
  ctx.classSet.add(className);
  ctx.classDeclarationMap.set(className, decl);

  // For class expressions, map the TS symbol name to the synthetic class name
  // so that resolveStructName and compileNewExpression can find the struct
  if (syntheticName) {
    const tsType = ctx.checker.getTypeAtLocation(decl);
    const symbolName = tsType.getSymbol()?.name;
    if (symbolName && symbolName !== syntheticName) {
      ctx.classExprNameMap.set(symbolName, syntheticName);
    }
  }

  // Detect parent class via heritage clauses (extends)
  let parentClassName: string | undefined;
  let parentStructTypeIdx: number | undefined;
  let parentFields: FieldDef[] = [];
  if (decl.heritageClauses) {
    for (const clause of decl.heritageClauses) {
      if (
        clause.token === ts.SyntaxKind.ExtendsKeyword &&
        clause.types.length > 0
      ) {
        const baseExpr = clause.types[0]!.expression;
        if (ts.isIdentifier(baseExpr)) {
          parentClassName = baseExpr.text;
          parentStructTypeIdx = ctx.structMap.get(parentClassName);
          parentFields = ctx.structFields.get(parentClassName) ?? [];
          // Record parent-child relationship
          ctx.classParentMap.set(className, parentClassName);
          // Mark parent struct as non-final so it can be extended
          if (parentStructTypeIdx !== undefined) {
            const parentTypeDef = ctx.mod.types[
              parentStructTypeIdx
            ] as StructTypeDef;
            if (parentTypeDef && parentTypeDef.superTypeIdx === undefined) {
              // Mark parent as extensible (superTypeIdx = -1 means "sub with no super")
              parentTypeDef.superTypeIdx = -1;
            }
          }
        }
      }
    }
  }

  // Find the constructor to determine struct fields from `this.x = ...` assignments
  const ctor = decl.members.find(ts.isConstructorDeclaration) as
    | ts.ConstructorDeclaration
    | undefined;
  const ownFields: FieldDef[] = [];

  if (ctor?.body) {
    for (const stmt of ctor.body.statements) {
      // Skip super() calls — they don't define new fields
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
      ) {
        continue;
      }
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(stmt.expression.left) &&
        stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const rawName = stmt.expression.left.name.text;
        const fieldName = ts.isPrivateIdentifier(stmt.expression.left.name) ? rawName.slice(1) : rawName;
        // Skip if this field is already defined in parent
        if (parentFields.some((f) => f.name === fieldName)) continue;
        const fieldTsType = ctx.checker.getTypeAtLocation(stmt.expression.left);
        const fieldType = resolveWasmType(ctx, fieldTsType);
        if (!ownFields.some((f) => f.name === fieldName)) {
          ownFields.push({ name: fieldName, type: fieldType, mutable: true });
        }
      }
    }
  }

  // Also collect fields from property declarations (class Point { x: number; y: number; })
  // Skip static properties — they become module globals, not struct fields
  for (const member of decl.members) {
    if (
      ts.isPropertyDeclaration(member) &&
      member.name
    ) {
      const fieldName = resolveClassMemberName(ctx, member.name);
      if (!fieldName) continue; // dynamic computed name — skip
      if (hasStaticModifier(member)) continue; // handled below
      // Skip if this field is already defined in parent
      if (parentFields.some((f) => f.name === fieldName)) continue;
      if (!ownFields.some((f) => f.name === fieldName)) {
        const fieldTsType = ctx.checker.getTypeAtLocation(member);
        const fieldType = resolveWasmType(ctx, fieldTsType);
        ownFields.push({ name: fieldName, type: fieldType, mutable: true });
      }
    }
  }

  // Build full fields list: parent fields first, then own fields
  const fields: FieldDef[] = [...parentFields, ...ownFields];

  // Register the struct type with optional super-type
  // Assign a unique class tag for instanceof support
  const classTag = ctx.classTagCounter++;
  ctx.classTagMap.set(className, classTag);

  // Add hidden __tag field at the beginning for instanceof discrimination
  // Only for root classes — child classes inherit __tag via parentFields
  if (!parentClassName) {
    fields.unshift({ name: "__tag", type: { kind: "i32" }, mutable: false });
  }

  // Register the struct type
  const structTypeIdx = ctx.mod.types.length;
  const structDef: StructTypeDef = { kind: "struct", name: className, fields };
  if (parentStructTypeIdx !== undefined) {
    structDef.superTypeIdx = parentStructTypeIdx;
  }
  ctx.mod.types.push(structDef);
  ctx.structMap.set(className, structTypeIdx);
  ctx.structFields.set(className, fields);

  // Register constructor function: takes ctor params, returns (ref $structTypeIdx)
  const ctorParams: ValType[] = [];
  const ctorName = `${className}_new`;
  if (ctor) {
    for (let i = 0; i < ctor.parameters.length; i++) {
      const param = ctor.parameters[i]!;
      if (param.dotDotDotToken) {
        // Rest parameter: ...args: T[] -> single (ref $__vec_elemKind) param (#382)
        const paramType = ctx.checker.getTypeAtLocation(param);
        const typeArgs = ctx.checker.getTypeArguments(paramType as ts.TypeReference);
        const elemTsType = typeArgs[0];
        const elemType: ValType = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
        const elemKey = (elemType.kind === "ref" || elemType.kind === "ref_null")
          ? `ref_${(elemType as { typeIdx: number }).typeIdx}`
          : elemType.kind;
        const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
        const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
        ctorParams.push({ kind: "ref_null", typeIdx: vecTypeIdx });
        ctx.funcRestParams.set(ctorName, {
          restIndex: i,
          elemType,
          arrayTypeIdx: arrTypeIdx,
          vecTypeIdx,
        });
      } else {
        const paramType = ctx.checker.getTypeAtLocation(param);
        ctorParams.push(resolveWasmType(ctx, paramType));
      }
    }
  }
  const ctorResults: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
  const ctorTypeIdx = addFuncType(
    ctx,
    ctorParams,
    ctorResults,
    `${className}_new_type`,
  );
  const ctorFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(ctorName, ctorFuncIdx);

  ctx.mod.functions.push({
    name: ctorName,
    typeIdx: ctorTypeIdx,
    locals: [],
    body: [],
    exported: false,
  });

  // Register method functions (own methods defined on this class)
  // Skip abstract methods — they have no body and are implemented by subclasses
  const ownMethodNames = new Set<string>();
  for (const member of decl.members) {
    if (
      ts.isMethodDeclaration(member) &&
      member.name
    ) {
      const methodName = resolveClassMemberName(ctx, member.name);
      if (!methodName) continue; // dynamic computed name — skip
      ownMethodNames.add(methodName);

      // Abstract methods have no body — skip generating a wasm function stub
      if (hasAbstractModifier(member)) continue;

      const fullName = `${className}_${methodName}`;
      const isStatic = hasStaticModifier(member);

      if (isStatic) {
        ctx.staticMethodSet.add(fullName);
      } else {
        ctx.classMethodSet.add(fullName);
      }

      // Static methods have no self parameter; instance methods get self: (ref $structTypeIdx)
      const methodParams: ValType[] = isStatic
        ? []
        : [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        methodParams.push(resolveWasmType(ctx, paramType));
      }

      // Track generator methods (method*)
      const isGeneratorMethod = member.asteriskToken !== undefined;
      if (isGeneratorMethod) {
        ctx.generatorFunctions.add(fullName);
      }

      const sig = ctx.checker.getSignatureFromDeclaration(member);
      let methodResults: ValType[] = [];
      if (isGeneratorMethod) {
        // Generator methods return externref (JS Generator object)
        methodResults = [{ kind: "externref" }];
      } else if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retType)) {
          methodResults = [resolveWasmType(ctx, retType)];
        }
      }

      const methodTypeIdx = addFuncType(
        ctx,
        methodParams,
        methodResults,
        `${fullName}_type`,
      );
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

  // Register getter/setter accessor functions
  for (const member of decl.members) {
    if (
      ts.isGetAccessorDeclaration(member) &&
      member.name
    ) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (!propName) continue; // dynamic computed name — skip
      const accessorKey = `${className}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);

      const getterName = `${className}_get_${propName}`;
      // Getter takes self, returns the accessor return type
      const getterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      let getterResults: ValType[] = [];
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retType)) {
          getterResults = [resolveWasmType(ctx, retType)];
        }
      }

      const getterTypeIdx = addFuncType(
        ctx,
        getterParams,
        getterResults,
        `${getterName}_type`,
      );
      const getterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(getterName, getterFuncIdx);

      ctx.mod.functions.push({
        name: getterName,
        typeIdx: getterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      });
    }

    if (
      ts.isSetAccessorDeclaration(member) &&
      member.name
    ) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (!propName) continue; // dynamic computed name — skip
      const accessorKey = `${className}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);

      const setterName = `${className}_set_${propName}`;
      // Setter takes self + value, returns void
      const setterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        setterParams.push(resolveWasmType(ctx, paramType));
      }

      const setterTypeIdx = addFuncType(
        ctx,
        setterParams,
        [],
        `${setterName}_type`,
      );
      const setterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(setterName, setterFuncIdx);

      ctx.mod.functions.push({
        name: setterName,
        typeIdx: setterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      });
    }
  }

  // Register inherited methods and accessors: if parent has methods/accessors
  // that child doesn't override, map ChildClass_X → ParentClass_X func index
  if (parentClassName) {
    // Collect own accessor names for override detection
    const ownAccessorNames = new Set<string>();
    for (const member of decl.members) {
      if ((ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name) {
        const accName = resolveClassMemberName(ctx, member.name);
        if (accName) ownAccessorNames.add(accName);
      }
    }

    // Walk the parent chain to find all inherited methods and accessors
    let ancestor: string | undefined = parentClassName;
    while (ancestor) {
      // Inherit methods
      for (const [key, funcIdx] of ctx.funcMap) {
        if (
          key.startsWith(`${ancestor}_`) &&
          !key.endsWith("_new") &&
          !key.endsWith("_type")
        ) {
          const suffix = key.substring(ancestor.length + 1);
          // Skip constructor-related entries
          if (suffix === "new" || suffix.startsWith("new_")) continue;
          // Check if this is a getter/setter (get_X or set_X)
          const getMatch = suffix.match(/^get_(.+)$/);
          const setMatch = suffix.match(/^set_(.+)$/);
          if (getMatch || setMatch) {
            // Accessor inheritance
            const accPropName = (getMatch || setMatch)![1]!;
            if (!ownAccessorNames.has(accPropName)) {
              const childFullName = `${className}_${suffix}`;
              if (!ctx.funcMap.has(childFullName)) {
                ctx.funcMap.set(childFullName, funcIdx);
              }
              // Also inherit accessor set entry
              const parentAccessorKey = `${ancestor}_${accPropName}`;
              const childAccessorKey = `${className}_${accPropName}`;
              if (ctx.classAccessorSet.has(parentAccessorKey) && !ctx.classAccessorSet.has(childAccessorKey)) {
                ctx.classAccessorSet.add(childAccessorKey);
              }
            }
          } else if (!suffix.includes("_")) {
            // Regular method (no underscores in method name)
            const childFullName = `${className}_${suffix}`;
            if (
              !ownMethodNames.has(suffix) &&
              !ctx.funcMap.has(childFullName)
            ) {
              ctx.funcMap.set(childFullName, funcIdx);
              ctx.classMethodSet.add(childFullName);
            }
          } else {
            // Method name contains underscore (e.g., my_method) — still inherit it
            const childFullName = `${className}_${suffix}`;
            if (
              !ownMethodNames.has(suffix) &&
              !ctx.funcMap.has(childFullName) &&
              ctx.classMethodSet.has(key)
            ) {
              ctx.funcMap.set(childFullName, funcIdx);
              ctx.classMethodSet.add(childFullName);
            }
          }
        }
      }
      ancestor = ctx.classParentMap.get(ancestor);
    }
  }

  // Register static properties as module globals
  for (const member of decl.members) {
    if (
      ts.isPropertyDeclaration(member) &&
      member.name &&
      hasStaticModifier(member)
    ) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (!propName) continue; // dynamic computed name — skip
      const fullName = `${className}_${propName}`;
      if (ctx.staticProps.has(fullName)) continue; // skip if already registered

      const propTsType = ctx.checker.getTypeAtLocation(member);
      const wasmType = resolveWasmType(ctx, propTsType);

      // Build null/zero initializer for the global
      const init: Instr[] =
        wasmType.kind === "f64"
          ? [{ op: "f64.const", value: 0 }]
          : wasmType.kind === "i32"
            ? [{ op: "i32.const", value: 0 }]
            : wasmType.kind === "i64"
              ? [{ op: "i64.const", value: 0n } as unknown as Instr]
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
        name: `__static_${fullName}`,
        type: globalType,
        mutable: true,
        init,
      });
      ctx.staticProps.set(fullName, globalIdx);

      // Store initializer expression for later compilation
      if (member.initializer) {
        ctx.staticInitExprs.push({
          globalIdx,
          initializer: member.initializer,
        });
      }
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

/**
 * Infer a concrete type for an untyped function parameter by scanning call sites.
 * When a parameter has no type annotation (TS gives it `any`), we look at every
 * call to that function and collect the argument types at the given index.
 * If all call sites agree on a single concrete wasm type, we return it.
 * Returns null if no call site found or types disagree.
 */
function inferParamTypeFromCallSites(
  ctx: CodegenContext,
  funcName: string,
  paramIndex: number,
  sourceFile: ts.SourceFile,
): ValType | null {
  let agreed: ValType | null = null;
  let conflict = false;

  function visit(node: ts.Node) {
    if (conflict) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === funcName
    ) {
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
function collectEmptyObjectWidening(
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
            const fields: FieldDef[] = extraProps.map(wp => ({
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
    }
  }

  scanStatements(sourceFile.statements);
}

function collectPropsFromStatements(
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
      if (bin.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(bin.left) &&
          ts.isIdentifier(bin.left.expression) &&
          bin.left.expression.text === varName) {
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
        if (
          ts.isIdentifier(objArg) &&
          objArg.text === varName &&
          ts.isStringLiteral(propArg)
        ) {
          const propName = propArg.text;
          if (!seenProps.has(propName)) {
            seenProps.add(propName);
            // Try to get value type from descriptor.value
            let wasmType: ValType = { kind: "externref" };
            if (ts.isObjectLiteralExpression(descArg)) {
              for (const prop of descArg.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name) &&
                  prop.name.text === "value"
                ) {
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
            if (
              ts.isIdentifier(objArg) &&
              objArg.text === varName &&
              ts.isStringLiteral(propArg)
            ) {
              const propName = propArg.text;
              if (!seenProps.has(propName)) {
                seenProps.add(propName);
                let wasmType: ValType = { kind: "externref" };
                if (ts.isObjectLiteralExpression(descArg)) {
                  for (const prop of descArg.properties) {
                    if (
                      ts.isPropertyAssignment(prop) &&
                      ts.isIdentifier(prop.name) &&
                      prop.name.text === "value"
                    ) {
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
    // Recurse into blocks (if/for/while bodies)
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
  }
}

/**
 * Apply shape inference: detect module-level variables used as array-like objects
 * and override their global types from externref/AnyValue to vec struct types.
 * Must be called after collectDeclarations (which registers module globals).
 */
function applyShapeInference(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
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
      } else if (ts.isVariableStatement(stmt) && !hasDeclareModifier(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            ts.isClassExpression(decl.initializer)
          ) {
            collectClassDeclaration(ctx, decl.initializer, decl.name.text);
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
      } else if (ts.isForStatement(stmt) || ts.isForInStatement(stmt) || ts.isForOfStatement(stmt) || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
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

      // Track generator functions (function*)
      const isGenerator = isGeneratorFunction(stmt);
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
      const unwrappedRetType = isAsync
        ? unwrapPromiseType(retType, ctx.checker)
        : retType;
      if (!isGenerator && !isVoidType(unwrappedRetType))
        ensureStructForType(ctx, unwrappedRetType);
      for (const p of stmt.parameters) {
        const pt = ctx.checker.getTypeAtLocation(p);
        ensureStructForType(ctx, pt);
      }

      let params: ValType[];
      let results: ValType[];

      if (isGenerator) {
        // Generator functions: parameters are compiled normally, return is externref
        params = [];
        for (let i = 0; i < stmt.parameters.length; i++) {
          const param = stmt.parameters[i]!;
          const paramType = ctx.checker.getTypeAtLocation(param);
          let wasmType = resolveWasmType(ctx, paramType);
          // Infer untyped any params from call sites (same as non-generator path)
          if (
            !param.type &&
            (paramType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
            (wasmType.kind === "externref" ||
              (wasmType.kind === "ref_null" && ctx.anyValueTypeIdx >= 0 &&
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
            const typeArgs = ctx.checker.getTypeArguments(
              paramType as ts.TypeReference,
            );
            const elemTsType = typeArgs[0];
            const elemType: ValType = elemTsType
              ? resolveWasmType(ctx, elemTsType)
              : { kind: "f64" };
            // Use a unique key for ref element types so each struct gets its own array type
            const elemKey =
              elemType.kind === "ref" || elemType.kind === "ref_null"
                ? `ref_${elemType.typeIdx}`
                : elemType.kind;
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
            let wasmType = resolveWasmType(ctx, paramType);
            // If the parameter has no explicit type annotation and resolved to
            // externref (from `any`), try to infer a concrete type from call sites.
            if (
              !param.type &&
              (paramType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
              (wasmType.kind === "externref" ||
                (wasmType.kind === "ref_null" && ctx.anyValueTypeIdx >= 0 &&
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
        results = isVoidType(rUnwrapped)
          ? []
          : [resolveWasmType(ctx, rUnwrapped)];
      }

      const optionalParams: OptionalParamInfo[] = [];
      for (let i = 0; i < stmt.parameters.length; i++) {
        const param = stmt.parameters[i]!;
        if (param.questionToken || param.initializer) {
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
            ? [{ op: "i64.const", value: 0n } as unknown as Instr]
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
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const varType = ctx.checker.getTypeAtLocation(decl);
          const wasmType = resolveWasmType(ctx, varType);
          registerModuleGlobal(decl.name.text, wasmType);
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
    if (ts.isForStatement(stmt) || ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)
        || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
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
      continue;
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

    // Collect assignment expressions that target module-level globals
    if (!ts.isBinaryExpression(expr)) continue;
    if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    // Check if the left side references a known module global
    let targetName: string | undefined;
    if (ts.isPropertyAccessExpression(expr.left) && ts.isIdentifier(expr.left.expression)) {
      targetName = expr.left.expression.text;
    } else if (ts.isElementAccessExpression(expr.left) && ts.isIdentifier(expr.left.expression)) {
      targetName = expr.left.expression.text;
    }
    if (targetName && ctx.moduleGlobals.has(targetName)) {
      ctx.moduleInitStatements.push(stmt);
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

/**
 * After all interfaces and type aliases are collected, re-resolve field types
 * that were initially mapped to externref but should be ref $struct.
 * This handles cross-references between interfaces regardless of declaration order.
 */
function resolveStructFieldTypes(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
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
  // Also compile class expressions in variable declarations
  // Scan recursively into function bodies for class expressions
  function compileClassesFromStatements(stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      if (ts.isClassDeclaration(stmt) && stmt.name && !hasDeclareModifier(stmt)) {
        try {
          compileClassBodies(ctx, stmt, funcByName);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          reportError(ctx, stmt, `Internal error compiling class '${stmt.name.text}': ${msg}`);
        }
      } else if (ts.isVariableStatement(stmt) && !hasDeclareModifier(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            ts.isClassExpression(decl.initializer)
          ) {
            try {
              compileClassBodies(ctx, decl.initializer, funcByName, decl.name.text);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              reportError(ctx, decl, `Internal error compiling class expression: ${msg}`);
            }
          }
          // Recurse into arrow functions and function expressions
          if (decl.initializer) {
            compileClassesFromFunctionBody(decl.initializer);
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        compileClassesFromStatements(stmt.body.statements);
      } else if (ts.isIfStatement(stmt)) {
        if (ts.isBlock(stmt.thenStatement)) {
          compileClassesFromStatements(stmt.thenStatement.statements);
        }
        if (stmt.elseStatement && ts.isBlock(stmt.elseStatement)) {
          compileClassesFromStatements(stmt.elseStatement.statements);
        }
      } else if (ts.isBlock(stmt)) {
        compileClassesFromStatements(stmt.statements);
      } else if (ts.isForStatement(stmt) || ts.isForInStatement(stmt) || ts.isForOfStatement(stmt) || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
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
        compileClassesFromStatements(expr.body.statements);
      }
    } else if (ts.isFunctionExpression(expr)) {
      if (expr.body) {
        compileClassesFromStatements(expr.body.statements);
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

  // Compile module-level init statements BEFORE function bodies so that
  // closureMap is populated for module-level arrow function variables.
  // This allows function bodies (e.g. test()) to reference module-level closures.
  const hasModuleInits = ctx.moduleInitStatements.length > 0;
  const hasStaticInits = ctx.staticInitExprs.length > 0;
  let compiledInitFctx: FunctionContext | null = null;

  if (hasModuleInits || hasStaticInits) {
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
    compiledInitFctx = initFctx;
    // Expose the pending init body so fixupModuleGlobalIndices can adjust it
    // when addStringConstantGlobal is called during function body compilation.
    ctx.pendingInitBody = initFctx.body;
  }

  // Compile top-level function declarations
  for (const stmt of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name &&
      !hasDeclareModifier(stmt)
    ) {
      if (stmt.body) {
        const idx = funcByName.get(stmt.name.text);
        if (idx !== undefined) {
          const func = ctx.mod.functions[idx]!;
          try {
            compileFunctionBody(ctx, stmt, func);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            reportError(ctx, stmt, `Internal error compiling function '${stmt.name.text}': ${msg}`);
          }
        }
      }
    }
  }

  // Clear pendingInitBody before injection (it will be in mod.functions or main body after this)
  ctx.pendingInitBody = null;

  // Inject the compiled init body into the appropriate location
  if (compiledInitFctx && compiledInitFctx.body.length > 0) {
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
      if (existingLocals > 0) {
        for (const instr of compiledInitFctx.body) {
          if (
            (instr.op === "local.get" ||
              instr.op === "local.set" ||
              instr.op === "local.tee") &&
            typeof (instr as any).index === "number"
          ) {
            (instr as any).index += existingLocals;
          }
        }
      }
    } else {
      // No main() function — create a standalone __module_init and inject
      // a guarded call at the start of every exported function.

      // Add a guard global: __init_done (i32, initially 0)
      const guardGlobalIdx = nextModuleGlobalIdx(ctx);
      ctx.mod.globals.push({
        name: "__init_done",
        type: { kind: "i32" },
        mutable: true,
        init: [{ op: "i32.const", value: 0 }],
      });

      // Create the __module_init function
      const initTypeIdx = addFuncType(ctx, [], [], "__module_init_type");
      const initFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.mod.functions.push({
        name: "__module_init",
        typeIdx: initTypeIdx,
        locals: compiledInitFctx.locals,
        body: compiledInitFctx.body,
        exported: false,
      });

      // Inject guarded call at the start of every exported function
      const guardPreamble: Instr[] = [
        { op: "global.get", index: guardGlobalIdx },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 1 } as Instr,
            { op: "global.set", index: guardGlobalIdx } as Instr,
            { op: "call", funcIdx: initFuncIdx } as Instr,
          ],
        } as Instr,
      ];

      for (const func of ctx.mod.functions) {
        if (func.exported && func.name !== "__module_init") {
          func.body = [...guardPreamble, ...func.body];
        }
      }
    }
  }
}

/** Scan all function bodies for ref.func instructions and record their targets */
function collectDeclaredFuncRefs(ctx: CodegenContext): void {
  const refs = new Set<number>();
  function scanInstrs(instrs: Instr[]): void {
    for (const instr of instrs) {
      if (instr.op === "ref.func") {
        refs.add((instr as { op: "ref.func"; funcIdx: number }).funcIdx);
      }
      // Recurse into nested instruction arrays (if/then/else, block/body, loop, try/catch)
      if ("body" in instr && Array.isArray((instr as any).body)) {
        scanInstrs((instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        scanInstrs((instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        scanInstrs((instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) scanInstrs(c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        scanInstrs((instr as any).catchAll);
      }
    }
  }
  for (const func of ctx.mod.functions) {
    scanInstrs(func.body);
  }
  if (refs.size > 0) {
    ctx.mod.declaredFuncRefs = [...refs].sort((a, b) => a - b);
  }
}

/** Compile constructor and method bodies for a class declaration */
export function compileClassBodies(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  funcByName: Map<string, number>,
  syntheticName?: string,
): void {
  const className = syntheticName ?? decl.name?.text;
  if (!className) {
    reportError(ctx, decl, "Cannot compile unnamed class");
    return;
  }
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, decl, `Unknown class struct type: ${className}`);
    return;
  }

  // Compile constructor
  const ctor = decl.members.find(ts.isConstructorDeclaration) as
    | ts.ConstructorDeclaration
    | undefined;
  const ctorName = `${className}_new`;
  const ctorLocalIdx = funcByName.get(ctorName);
  if (ctorLocalIdx !== undefined) {
    const func = ctx.mod.functions[ctorLocalIdx]!;
    const params: { name: string; type: ValType }[] = [];
    if (ctor) {
      for (let pi = 0; pi < ctor.parameters.length; pi++) {
        const param = ctor.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
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
      labelMap: new Map(),
      savedBodies: [],
      isConstructor: true,
    };

    for (let i = 0; i < params.length; i++) {
      fctx.localMap.set(params[i]!.name, i);
    }

    // Allocate a local for the struct instance
    const selfLocal = allocLocal(fctx, "__self", {
      kind: "ref",
      typeIdx: structTypeIdx,
    });

    // Push default values for all fields, then struct.new
    for (const field of fields) {
      if (field.name === "__tag") {
        // Push the class-specific tag value for instanceof discrimination
        const tagValue = ctx.classTagMap.get(className) ?? 0;
        fctx.body.push({ op: "i32.const", value: tagValue });
      } else if (field.type.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (field.type.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (field.type.kind === "externref") {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (field.type.kind === "ref" || field.type.kind === "ref_null") {
        fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
      } else if ((field.type as any).kind === "i64") {
        fctx.body.push({ op: "i64.const", value: 0n } as unknown as Instr);
      } else if ((field.type as any).kind === "eqref") {
        fctx.body.push({ op: "ref.null.eq" } as unknown as Instr);
      } else {
        // Fallback for any unhandled type — push i32 0
        fctx.body.push({ op: "i32.const", value: 0 });
      }
    }
    fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
    fctx.body.push({ op: "local.set", index: selfLocal });

    // Compile constructor body — `this` maps to __self local
    fctx.localMap.set("this", selfLocal);
    ctx.currentFunc = fctx;

    // Emit default-value initialization for constructor parameters with initializers.
    // For each param with a default value, check if the caller passed the zero/null
    // sentinel (meaning the argument was omitted) and if so, compile the initializer
    // expression and assign it to the param local.
    if (ctor) {
      for (let i = 0; i < ctor.parameters.length; i++) {
        const param = ctor.parameters[i]!;
        if (!param.initializer) continue;

        const paramIdx = i;
        const paramType = params[i]!.type;

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(fctx);
        compileExpression(ctx, fctx, param.initializer, paramType);
        fctx.body.push({ op: "local.set", index: paramIdx });
        const thenInstrs = fctx.body;
        popBody(fctx, savedBody);

        // Emit the null/zero check + conditional assignment
        if (paramType.kind === "externref") {
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (
          paramType.kind === "ref_null" ||
          paramType.kind === "ref"
        ) {
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (paramType.kind === "i32") {
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (paramType.kind === "f64") {
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "f64.const", value: 0 });
          fctx.body.push({ op: "f64.eq" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        }
      }
    }

    // When a child class has no explicit constructor, run inherited field
    // initializers from the parent chain (implicit super() semantics).
    // This must happen before own field initializers.
    if (!ctor) {
      const parentClassName = ctx.classParentMap.get(className);
      if (parentClassName) {
        // Walk the parent chain (grandparent first) and compile field initializers
        const ancestors: string[] = [];
        let anc: string | undefined = parentClassName;
        while (anc) {
          ancestors.unshift(anc);
          anc = ctx.classParentMap.get(anc);
        }
        for (const ancName of ancestors) {
          const ancDecl = ctx.classDeclarationMap.get(ancName);
          if (!ancDecl) continue;
          for (const member of ancDecl.members) {
            if (
              ts.isPropertyDeclaration(member) &&
              member.name &&
              member.initializer &&
              !hasStaticModifier(member)
            ) {
              const fieldName = resolveClassMemberName(ctx, member.name);
              if (!fieldName) continue;
              const fieldIdx = fields.findIndex((f) => f.name === fieldName);
              if (fieldIdx !== -1) {
                fctx.body.push({ op: "local.get", index: selfLocal });
                compileExpression(ctx, fctx, member.initializer, fields[fieldIdx]!.type);
                fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
              }
            }
          }
          // Also run constructor body assignments (this.x = ...) from the parent
          const ancCtor = ancDecl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
          if (ancCtor?.body) {
            for (const stmt of ancCtor.body.statements) {
              if (
                ts.isExpressionStatement(stmt) &&
                ts.isCallExpression(stmt.expression) &&
                stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
              ) {
                continue; // skip super() — already handled by ancestor chain order
              }
              if (
                ts.isExpressionStatement(stmt) &&
                ts.isBinaryExpression(stmt.expression) &&
                stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(stmt.expression.left) &&
                stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
              ) {
                const rawName = stmt.expression.left.name.text;
                const fieldName = ts.isPrivateIdentifier(stmt.expression.left.name) ? rawName.slice(1) : rawName;
                const fieldIdx = fields.findIndex((f) => f.name === fieldName);
                if (fieldIdx !== -1) {
                  fctx.body.push({ op: "local.get", index: selfLocal });
                  compileExpression(ctx, fctx, stmt.expression.right, fields[fieldIdx]!.type);
                  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
                }
              }
            }
          }
        }
      }
    }

    // Compile field initializers from property declarations (e.g., x: number = 42, #x: number = 42)
    for (const member of decl.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        member.name &&
        member.initializer &&
        !hasStaticModifier(member)
      ) {
        const fieldName = resolveClassMemberName(ctx, member.name);
        if (!fieldName) continue; // dynamic computed name — skip
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1) {
          fctx.body.push({ op: "local.get", index: selfLocal });
          compileExpression(ctx, fctx, member.initializer, fields[fieldIdx]!.type);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
        }
      }
    }

    if (ctor?.body) {
      for (const stmt of ctor.body.statements) {
        // Handle super(args) calls: inline parent constructor field initialization
        if (
          ts.isExpressionStatement(stmt) &&
          ts.isCallExpression(stmt.expression) &&
          stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
        ) {
          compileSuperCall(
            ctx,
            fctx,
            className,
            selfLocal,
            stmt.expression,
            fields,
          );
          continue;
        }
        compileStatement(ctx, fctx, stmt);
      }
    }

    // Return the struct instance
    fctx.body.push({ op: "local.get", index: selfLocal });

    cacheStringLiterals(ctx, fctx);
    func.locals = fctx.locals;
    func.body = fctx.body;
    ctx.currentFunc = null;
  }

  // Compile methods (instance and static)
  for (const member of decl.members) {
    if (
      ts.isMethodDeclaration(member) &&
      member.name
    ) {
      const methodName = resolveClassMemberName(ctx, member.name);
      if (!methodName) continue; // dynamic computed name — skip
      const fullName = `${className}_${methodName}`;
      const isStatic = ctx.staticMethodSet.has(fullName);
      const methodLocalIdx = funcByName.get(fullName);
      if (methodLocalIdx === undefined) continue;

      const func = ctx.mod.functions[methodLocalIdx]!;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      const retType = sig
        ? ctx.checker.getReturnTypeOfSignature(sig)
        : undefined;

      // Static methods have no self param; instance methods get self as first param
      const params: { name: string; type: ValType }[] = isStatic
        ? []
        : [{ name: "this", type: { kind: "ref", typeIdx: structTypeIdx } }];
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        params.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
      }

      const isGeneratorMethod = member.asteriskToken !== undefined;

      const fctx: FunctionContext = {
        name: fullName,
        params,
        locals: [],
        localMap: new Map(),
        returnType: isGeneratorMethod
          ? { kind: "externref" }
          : (retType && !isVoidType(retType)
            ? resolveWasmType(ctx, retType)
            : null),
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
      };

      for (let i = 0; i < params.length; i++) {
        fctx.localMap.set(params[i]!.name, i);
      }

      ctx.currentFunc = fctx;

      // Emit default-value initialization for method parameters with initializers.
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        if (!param.initializer) continue;

        const paramLocalIdx = isStatic ? pi : pi + 1; // account for 'this' param
        const paramType = params[paramLocalIdx]!.type;

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(fctx);
        compileExpression(ctx, fctx, param.initializer, paramType);
        fctx.body.push({ op: "local.set", index: paramLocalIdx });
        const thenInstrs = fctx.body;
        popBody(fctx, savedBody);

        // Emit the null/zero check + conditional assignment
        if (paramType.kind === "externref") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (
          paramType.kind === "ref_null" ||
          paramType.kind === "ref"
        ) {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (paramType.kind === "i32") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        } else if (paramType.kind === "f64") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "f64.const", value: 0 });
          fctx.body.push({ op: "f64.eq" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
          });
        }
      }

      // Destructure parameters with binding patterns
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        const paramLocalIdx = isStatic ? pi : pi + 1; // account for 'this' param
        if (ts.isObjectBindingPattern(param.name)) {
          destructureParamObject(ctx, fctx, paramLocalIdx, param.name, params[paramLocalIdx]!.type);
        } else if (ts.isArrayBindingPattern(param.name)) {
          destructureParamArray(ctx, fctx, paramLocalIdx, param.name, params[paramLocalIdx]!.type);
        }
      }

      if (isGeneratorMethod && member.body) {
        // Generator method: eagerly evaluate body, collect yields into a buffer,
        // then wrap with __create_generator to return a Generator-like object.
        const bufferLocal = allocLocal(fctx, "__gen_buffer", { kind: "externref" });
        const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
        fctx.body.push({ op: "call", funcIdx: createBufIdx });
        fctx.body.push({ op: "local.set", index: bufferLocal });

        // Wrap body in a block so return can br out
        const bodyInstrs: Instr[] = [];
        const outerBody = fctx.body;
        fctx.body = bodyInstrs;

        fctx.generatorReturnDepth = 0;
        fctx.blockDepth++;
        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }

        fctx.blockDepth--;
        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
        fctx.generatorReturnDepth = undefined;

        fctx.body = outerBody;
        fctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: bodyInstrs,
        });

        // Return __create_generator(__gen_buffer)
        const createGenIdx = ctx.funcMap.get("__create_generator")!;
        fctx.body.push({ op: "local.get", index: bufferLocal });
        fctx.body.push({ op: "call", funcIdx: createGenIdx });
      } else if (member.body) {
        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }
      }

      // Ensure valid return for non-void, non-generator methods
      if (fctx.returnType && !isGeneratorMethod) {
        const lastInstr = fctx.body[fctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (fctx.returnType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: 0 });
          } else if (fctx.returnType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (fctx.returnType.kind === "externref") {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (
            fctx.returnType.kind === "ref" ||
            fctx.returnType.kind === "ref_null"
          ) {
            fctx.body.push({
              op: "ref.null",
              typeIdx: fctx.returnType.typeIdx,
            });
          }
        }
      }

      cacheStringLiterals(ctx, fctx);
      func.locals = fctx.locals;
      func.body = fctx.body;
      ctx.currentFunc = null;
    }
  }

  // Compile getter/setter accessor bodies
  for (const member of decl.members) {
    if (
      ts.isGetAccessorDeclaration(member) &&
      member.name
    ) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (!propName) continue; // dynamic computed name — skip
      const getterName = `${className}_get_${propName}`;
      const getterLocalIdx = funcByName.get(getterName);
      if (getterLocalIdx === undefined) continue;

      const func = ctx.mod.functions[getterLocalIdx]!;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      const retType = sig
        ? ctx.checker.getReturnTypeOfSignature(sig)
        : undefined;

      const params: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];

      const fctx: FunctionContext = {
        name: getterName,
        params,
        locals: [],
        localMap: new Map(),
        returnType:
          retType && !isVoidType(retType)
            ? resolveWasmType(ctx, retType)
            : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
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

      // Ensure valid return for non-void getters
      if (fctx.returnType) {
        const lastInstr = fctx.body[fctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (fctx.returnType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: 0 });
          } else if (fctx.returnType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (fctx.returnType.kind === "externref") {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (
            fctx.returnType.kind === "ref" ||
            fctx.returnType.kind === "ref_null"
          ) {
            fctx.body.push({
              op: "ref.null",
              typeIdx: fctx.returnType.typeIdx,
            });
          }
        }
      }

      cacheStringLiterals(ctx, fctx);
      func.locals = fctx.locals;
      func.body = fctx.body;
      ctx.currentFunc = null;
    }

    if (
      ts.isSetAccessorDeclaration(member) &&
      member.name
    ) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (!propName) continue; // dynamic computed name — skip
      const setterName = `${className}_set_${propName}`;
      const setterLocalIdx = funcByName.get(setterName);
      if (setterLocalIdx === undefined) continue;

      const func = ctx.mod.functions[setterLocalIdx]!;

      // First param is self, remaining are the setter parameters
      const params: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        params.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
      }

      const fctx: FunctionContext = {
        name: setterName,
        params,
        locals: [],
        localMap: new Map(),
        returnType: null, // setters always return void
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
      };

      for (let i = 0; i < params.length; i++) {
        fctx.localMap.set(params[i]!.name, i);
      }

      ctx.currentFunc = fctx;

      // Emit default-value initialization for setter parameters with initializers (#377)
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        if (!param.initializer) continue;

        const paramLocalIdx = pi + 1; // account for 'this' param
        const paramType = params[paramLocalIdx]!.type;

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(fctx);
        compileExpression(ctx, fctx, param.initializer, paramType);
        fctx.body.push({ op: "local.set", index: paramLocalIdx });
        const thenInstrs = fctx.body;
        popBody(fctx, savedBody);

        // Emit the null/zero check + conditional assignment
        if (paramType.kind === "externref") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "i32") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "f64") {
          fctx.body.push({ op: "local.get", index: paramLocalIdx });
          fctx.body.push({ op: "f64.const", value: 0 });
          fctx.body.push({ op: "f64.eq" });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        }
      }

      if (member.body) {
        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }
      }

      cacheStringLiterals(ctx, fctx);
      func.locals = fctx.locals;
      func.body = fctx.body;
      ctx.currentFunc = null;
    }
  }
}

/**
 * Compile a super(args) call inside a child constructor.
 * This runs the parent constructor's field-initialization logic inline:
 * for each parent field, evaluate the corresponding super argument and
 * store it into the child struct (which includes parent fields at the start).
 */
function compileSuperCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  childClassName: string,
  selfLocal: number,
  callExpr: ts.CallExpression,
  _allFields: FieldDef[],
): void {
  const parentClassName = ctx.classParentMap.get(childClassName);
  if (!parentClassName) return;

  const parentFields = ctx.structFields.get(parentClassName) ?? [];
  const structTypeIdx = ctx.structMap.get(childClassName)!;

  // Evaluate super(args) and assign to parent fields on the child struct.
  // Skip __tag (immutable, already set by struct.new) and map arguments to
  // the remaining parent fields in order.
  const assignableParentFields = parentFields
    .map((f, idx) => ({ field: f, fieldIdx: idx }))
    .filter((e) => e.field.name !== "__tag");

  // Check if any argument uses spread syntax: super(...args) (#382)
  const hasSuperSpread = callExpr.arguments.some((a) => ts.isSpreadElement(a));

  if (hasSuperSpread) {
    // Handle spread arguments: super(...args) where args is a vec struct { length, data }
    let fieldIdx2 = 0;
    for (const arg of callExpr.arguments) {
      if (ts.isSpreadElement(arg)) {
        const vecType = compileExpression(ctx, fctx, arg.expression);
        if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) continue;
        const vecLocal = allocLocal(fctx, `__super_spread_vec_${fctx.locals.length}`, vecType);
        fctx.body.push({ op: "local.set", index: vecLocal });
        const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecType.typeIdx);
        if (arrTypeIdx < 0) continue;
        const dataLocal = allocLocal(fctx, `__super_spread_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "local.get", index: vecLocal });
        fctx.body.push({ op: "struct.get", typeIdx: vecType.typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "local.set", index: dataLocal });
        const remaining = assignableParentFields.length - fieldIdx2;
        for (let i = 0; i < remaining; i++) {
          const { fieldIdx } = assignableParentFields[fieldIdx2]!;
          fctx.body.push({ op: "local.get", index: selfLocal });
          fctx.body.push({ op: "local.get", index: dataLocal });
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fieldIdx2++;
        }
      } else {
        if (fieldIdx2 < assignableParentFields.length) {
          const { field, fieldIdx } = assignableParentFields[fieldIdx2]!;
          fctx.body.push({ op: "local.get", index: selfLocal });
          compileExpression(ctx, fctx, arg, field.type);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fieldIdx2++;
        }
      }
    }
  } else {
    for (
      let i = 0;
      i < callExpr.arguments.length && i < assignableParentFields.length;
      i++
    ) {
      const { field, fieldIdx } = assignableParentFields[i]!;
      fctx.body.push({ op: "local.get", index: selfLocal });
      compileExpression(ctx, fctx, callExpr.arguments[i]!, field.type);
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    }
  }
}

/**
 * Pre-pass: hoist all `var` declarations in a function body.
 * Walks statements recursively and pre-allocates a local for each `var`
 * variable not yet in localMap, so identifiers are valid before their
 * declaration site (JavaScript var-hoisting semantics).
 */
function hoistVarDeclarations(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
  for (const stmt of stmts) {
    walkStmtForVars(ctx, fctx, stmt);
  }
}

/**
 * Walk a binding pattern and hoist all bound identifiers as locals.
 * Handles nested patterns: var { a, b: { c } } = obj; var [x, [y, z]] = arr;
 */
function hoistBindingPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.BindingPattern,
): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      const name = element.name.text;
      if (fctx.localMap.has(name)) continue;
      if (ctx.moduleGlobals.has(name)) continue;
      const elemType = ctx.checker.getTypeAtLocation(element);
      const wasmType = resolveWasmType(ctx, elemType);
      allocLocal(fctx, name, wasmType);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      hoistBindingPattern(ctx, fctx, element.name);
    }
  }
}

/** Hoist a single variable declaration (handles both simple identifiers and binding patterns). */
function hoistVarDecl(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
): void {
  if (ts.isIdentifier(decl.name)) {
    const name = decl.name.text;
    if (fctx.localMap.has(name)) return;
    if (ctx.moduleGlobals.has(name)) return;
    const varType = ctx.checker.getTypeAtLocation(decl);
    const wasmType = resolveWasmType(ctx, varType);
    allocLocal(fctx, name, wasmType);
    return;
  }
  // Handle destructuring patterns: var { x, y } = obj; var [a, b] = arr;
  if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
    hoistBindingPattern(ctx, fctx, decl.name);
  }
}

function walkStmtForVars(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.Statement,
): void {
  if (ts.isVariableStatement(stmt)) {
    const list = stmt.declarationList;
    // Only hoist `var` (not let/const)
    if (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) return;
    for (const decl of list.declarations) {
      hoistVarDecl(ctx, fctx, decl);
    }
    return;
  }
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) walkStmtForVars(ctx, fctx, s);
    return;
  }
  if (ts.isIfStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.thenStatement);
    if (stmt.elseStatement) walkStmtForVars(ctx, fctx, stmt.elseStatement);
    return;
  }
  if (ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isForStatement(stmt)) {
    if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
      const list = stmt.initializer;
      if (!(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
        for (const decl of list.declarations) {
          hoistVarDecl(ctx, fctx, decl);
        }
      }
    }
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
    // Hoist the loop variable for `for (var x in obj)` / `for (var x of arr)`
    if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
      const list = stmt.initializer;
      if (!(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
        for (const decl of list.declarations) {
          hoistVarDecl(ctx, fctx, decl);
        }
      }
    }
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isLabeledStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isTryStatement(stmt)) {
    for (const s of stmt.tryBlock.statements) walkStmtForVars(ctx, fctx, s);
    if (stmt.catchClause) {
      for (const s of stmt.catchClause.block.statements) walkStmtForVars(ctx, fctx, s);
    }
    if (stmt.finallyBlock) {
      for (const s of stmt.finallyBlock.statements) walkStmtForVars(ctx, fctx, s);
    }
    return;
  }
  if (ts.isSwitchStatement(stmt)) {
    for (const clause of stmt.caseBlock.clauses) {
      for (const s of clause.statements) walkStmtForVars(ctx, fctx, s);
    }
  }
}

/**
 * Check if a function body references the `arguments` identifier.
 * Only checks direct children (not nested functions/arrows which have their own `arguments`).
 */
function bodyUsesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  // Don't recurse into nested functions/arrows — they have their own `arguments` scope
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return false;
  }
  return ts.forEachChild(node, bodyUsesArguments) ?? false;
}

function compileFunctionBody(
  ctx: CodegenContext,
  decl: ts.FunctionDeclaration,
  func: WasmFunction,
): void {
  const sig = ctx.checker.getSignatureFromDeclaration(decl);
  if (!sig) {
    reportError(ctx, decl, `Cannot resolve signature for function '${func.name}'`);
    return;
  }
  const retType = ctx.checker.getReturnTypeOfSignature(sig);

  // For async functions, unwrap Promise<T> to get T
  const isAsync = ctx.asyncFunctions.has(func.name);
  const isGenerator = ctx.generatorFunctions.has(func.name);
  const effectiveRetType = isAsync
    ? unwrapPromiseType(retType, ctx.checker)
    : retType;

  // Use call-site resolved types for generic functions
  const resolved = ctx.genericResolved.get(func.name);

  const restInfo = ctx.funcRestParams.get(func.name);
  const params: { name: string; type: ValType }[] = [];
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${i}`;
    if (restInfo && i === restInfo.restIndex) {
      // Rest parameter — use the vec struct ref type from the function signature
      params.push({
        name: paramName,
        type: { kind: "ref_null", typeIdx: restInfo.vecTypeIdx },
      });
    } else {
      // Prefer the type already established in the function signature (which
      // may have been inferred from call sites for untyped params).
      const funcType = ctx.mod.types[func.typeIdx];
      const sigParamType = funcType?.kind === "func" ? funcType.params[i] : undefined;
      const paramType = resolved?.params[i]
        ?? sigParamType
        ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(param));
      params.push({ name: paramName, type: paramType });
    }
  }

  let returnType: ValType | null;
  if (isGenerator) {
    // Generator functions return externref (JS Generator object)
    returnType = { kind: "externref" };
  } else if (resolved) {
    returnType = resolved.results.length > 0 ? (resolved.results[0] ?? null) : null;
  } else {
    returnType = isVoidType(effectiveRetType)
      ? null
      : resolveWasmType(ctx, effectiveRetType);
  }

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
    labelMap: new Map(),
    savedBodies: [],
  };

  // Register params as locals
  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i]!.name, i);
  }

  ctx.currentFunc = fctx;

  // Mark function entry with source position
  const funcPos = getSourcePos(ctx, decl);
  if (funcPos) {
    const nop: Instr = { op: "nop" };
    attachSourcePos(nop, funcPos);
    fctx.body.push(nop);
  }

  // Emit default-value initialization for parameters with initializers.
  // For each param with a default value, check if the caller omitted it
  // (externref → ref.is_null, i32 → i32.eqz, f64 → f64.eq 0.0) and if so
  // compile the initializer expression and assign it to the param local.
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    if (!param.initializer) continue;

    const paramIdx = i;
    const paramType = params[i]!.type;

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(fctx);
    compileExpression(ctx, fctx, param.initializer, paramType);
    fctx.body.push({ op: "local.set", index: paramIdx });
    const thenInstrs = fctx.body;
    popBody(fctx, savedBody);

    // Emit the null/zero check + conditional assignment
    if (paramType.kind === "externref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (
      paramType.kind === "ref_null" ||
      paramType.kind === "ref"
    ) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "i32") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "f64") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    }
  }

  // Destructure parameters with binding patterns.
  // When a parameter is declared as e.g. function([x, y, z]) or function({a, b}),
  // the parameter is received as a single value (vec struct or struct ref) and
  // we need to extract the individual bindings into separate locals.
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    if (ts.isObjectBindingPattern(param.name)) {
      destructureParamObject(ctx, fctx, i, param.name, params[i]!.type);
    } else if (ts.isArrayBindingPattern(param.name)) {
      destructureParamArray(ctx, fctx, i, param.name, params[i]!.type);
    }
  }

  // Set up `arguments` object if the function body references it.
  // We create a vec struct (same as Array) populated from all function parameters.
  if (decl.body && bodyUsesArguments(decl.body)) {
    const elemKey = ctx.fast ? "i32" : "f64";
    const elemType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
    const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const vecRef: ValType = { kind: "ref", typeIdx: vecTypeIdx };

    const argsLocal = allocLocal(fctx, "arguments", vecRef);
    const arrTmp = allocLocal(fctx, "__args_arr_tmp", { kind: "ref", typeIdx: arrTypeIdx });

    // Create backing array from parameters: push each param coerced to f64/i32
    for (let i = 0; i < params.length; i++) {
      const paramType = params[i]!.type;
      fctx.body.push({ op: "local.get", index: i });
      // Coerce parameter to the element type (f64 or i32 in fast mode)
      if (ctx.fast) {
        if (paramType.kind === "f64") {
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        } else if (paramType.kind === "externref" || paramType.kind === "ref" || paramType.kind === "ref_null") {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: 0 });
        }
      } else {
        if (paramType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else if (paramType.kind === "externref" || paramType.kind === "ref" || paramType.kind === "ref_null") {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "f64.const", value: 0 });
        }
      }
    }
    // array.new_fixed creates the backing array
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: params.length });
    fctx.body.push({ op: "local.set", index: arrTmp });
    // Create vec struct: { length: i32, data: ref $arr }
    fctx.body.push({ op: "i32.const", value: params.length });
    fctx.body.push({ op: "local.get", index: arrTmp });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    fctx.body.push({ op: "local.set", index: argsLocal });
  }

  if (isGenerator) {
    // Generator function: eagerly evaluate body, collect yields into a JS array,
    // then wrap it with __create_generator to return a Generator-like object.
    const bufferLocal = allocLocal(fctx, "__gen_buffer", { kind: "externref" });

    // Create buffer: __gen_buffer = __gen_create_buffer()
    const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
    fctx.body.push({ op: "call", funcIdx: createBufIdx });
    fctx.body.push({ op: "local.set", index: bufferLocal });

    // Wrap the generator body in a block so that `return` statements inside
    // the body can `br` out to the generator creation code instead of
    // using the wasm `return` opcode (which would skip __create_generator).
    const bodyInstrs: Instr[] = [];
    const outerBody = fctx.body;
    fctx.body = bodyInstrs;

    // Set generator return depth for correct `br` depth in nested contexts
    fctx.generatorReturnDepth = 0;

    // Push a block label level so return can break out
    fctx.blockDepth++;
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

    if (decl.body) {
      hoistVarDeclarations(ctx, fctx, decl.body.statements);
      hoistFunctionDeclarations(ctx, fctx, decl.body.statements);
      for (const stmt of decl.body.statements) {
        compileStatement(ctx, fctx, stmt);
      }
    }

    fctx.blockDepth--;
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
    fctx.generatorReturnDepth = undefined;

    // Restore outer body and wrap compiled body in a block
    fctx.body = outerBody;
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    });

    // Return __create_generator(__gen_buffer)
    const createGenIdx = ctx.funcMap.get("__create_generator")!;
    fctx.body.push({ op: "local.get", index: bufferLocal });
    fctx.body.push({ op: "call", funcIdx: createGenIdx });
    // The externref Generator object is now on the stack as the return value
  } else {
    // Compile body statements
    if (decl.body) {
      // Hoist `var` declarations: pre-allocate locals so variables are accessible
      // even before their declaration site (JS var hoisting semantics).
      hoistVarDeclarations(ctx, fctx, decl.body.statements);
      // Hoist function declarations: JS semantics require function declarations
      // to be available before their textual position in the enclosing scope.
      hoistFunctionDeclarations(ctx, fctx, decl.body.statements);
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
        } else if (
          fctx.returnType.kind === "ref" ||
          fctx.returnType.kind === "ref_null"
        ) {
          fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
        }
      }
    }
  }

  cacheStringLiterals(ctx, fctx);
  func.locals = fctx.locals;
  func.body = fctx.body;

  ctx.currentFunc = null;
}

/**
 * Destructure a function parameter that is an ObjectBindingPattern.
 * The parameter value (a struct ref) is at param index `paramIdx`.
 * We extract each bound field into a new local.
 */
function destructureParamObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  pattern: ts.ObjectBindingPattern,
  paramType: ValType,
): void {
  if (paramType.kind !== "ref" && paramType.kind !== "ref_null") {
    // Cannot destructure a non-ref type — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name)) {
        const name = element.name.text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          allocLocal(fctx, name, resolveWasmType(ctx, elemType));
        }
      }
    }
    return;
  }

  const structTypeIdx = (paramType as { typeIdx: number }).typeIdx;

  // Find struct name and fields
  let structName: string | undefined;
  for (const [name, idx] of ctx.structMap) {
    if (idx === structTypeIdx) { structName = name; break; }
  }
  const fields = structName ? ctx.structFields.get(structName) : undefined;
  if (!fields) {
    // Cannot find struct info — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name)) {
        const name = element.name.text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          allocLocal(fctx, name, resolveWasmType(ctx, elemType));
        }
      }
    }
    return;
  }

  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;
    const propName = (element.propertyName ?? element.name) as ts.Identifier;
    if (!ts.isIdentifier(element.name)) {
      // Nested pattern — recurse
      if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        const fieldIdx = fields.findIndex((f) => f.name === propName.text);
        if (fieldIdx === -1) continue;
        const fieldType = fields[fieldIdx]!.type;
        const tmpLocal = allocLocal(fctx, `__dparam_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpLocal });
        if (ts.isObjectBindingPattern(element.name)) {
          destructureParamObject(ctx, fctx, tmpLocal, element.name, fieldType);
        } else {
          destructureParamArray(ctx, fctx, tmpLocal, element.name, fieldType);
        }
      }
      continue;
    }
    const localName = element.name.text;
    const fieldIdx = fields.findIndex((f) => f.name === propName.text);
    if (fieldIdx === -1) {
      // Field not in struct — allocate local with default value
      const elemType = ctx.checker.getTypeAtLocation(element);
      const wasmType = resolveWasmType(ctx, elemType);
      allocLocal(fctx, localName, wasmType);
      continue;
    }
    const fieldType = fields[fieldIdx]!.type;
    const localIdx = allocLocal(fctx, localName, fieldType);
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
    fctx.body.push({ op: "local.set", index: localIdx });
  }
}

/**
 * Destructure a function parameter that is an ArrayBindingPattern.
 * The parameter value (a vec struct ref) is at param index `paramIdx`.
 * We extract each element into a new local.
 */
function destructureParamArray(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  pattern: ts.ArrayBindingPattern,
  paramType: ValType,
): void {
  if (paramType.kind !== "ref" && paramType.kind !== "ref_null") {
    // Cannot destructure a non-ref type — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier((element as ts.BindingElement).name)) {
        const name = ((element as ts.BindingElement).name as ts.Identifier).text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          allocLocal(fctx, name, resolveWasmType(ctx, elemType));
        }
      }
    }
    return;
  }

  const vecTypeIdx = (paramType as { typeIdx: number }).typeIdx;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") {
    // Not an array — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier((element as ts.BindingElement).name)) {
        const name = ((element as ts.BindingElement).name as ts.Identifier).text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          allocLocal(fctx, name, resolveWasmType(ctx, elemType));
        }
      }
    }
    return;
  }

  const elemType = arrDef.element;

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;

    // Handle nested binding patterns
    if (ts.isBindingElement(element) &&
        (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))) {
      const tmpLocal = allocLocal(fctx, `__dparam_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // get data
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.set", index: tmpLocal });
      if (ts.isObjectBindingPattern(element.name)) {
        destructureParamObject(ctx, fctx, tmpLocal, element.name, elemType);
      } else {
        destructureParamArray(ctx, fctx, tmpLocal, element.name, elemType);
      }
      continue;
    }

    // Handle rest element: function([a, ...rest])
    if (element.dotDotDotToken) {
      const restName = (element.name as ts.Identifier).text;
      // rest gets the remainder of the array as a new vec
      // For simplicity, allocate as same vec type
      const restLocal = allocLocal(fctx, restName, paramType);
      // TODO: create a sub-array — for now just register the local
      continue;
    }

    const localName = (element.name as ts.Identifier).text;
    const localIdx = allocLocal(fctx, localName, elemType);
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // get data
    fctx.body.push({ op: "i32.const", value: i });
    fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: localIdx });
  }
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

/** Get the ValType of a local by index (param or local slot) */
export function getLocalType(fctx: FunctionContext, index: number): ValType | undefined {
  if (index < fctx.params.length) return fctx.params[index]!.type;
  const localIdx = index - fctx.params.length;
  return fctx.locals[localIdx]?.type;
}

/**
 * Cache string literal thunk calls in locals for the given function.
 *
 * After a function body has been compiled, this scans all instructions
 * (including nested blocks/loops/ifs) for `call` instructions that invoke
 * string literal thunks (__str_N).  For each unique thunk found it:
 *   1. Allocates an `externref` local to hold the cached value.
 *   2. Prepends `call $__str_N` + `local.set $cached` at function entry.
 *   3. Replaces every matching `call` in the body with `local.get $cached`.
 *
 * This avoids repeated import calls for the same string literal, which is
 * especially beneficial inside loops.
 */
export function cacheStringLiterals(
  ctx: CodegenContext,
  fctx: FunctionContext,
): void {
  // Build a set of funcIdx values that correspond to string literal thunks
  const strFuncIdxSet = new Set<number>();
  for (const [, importName] of ctx.stringLiteralMap) {
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) strFuncIdxSet.add(funcIdx);
  }
  if (strFuncIdxSet.size === 0) return;

  // Collect all unique string-thunk funcIdx values used in the body
  const usedFuncIdxs = new Set<number>();
  collectStringCalls(fctx.body, strFuncIdxSet, usedFuncIdxs);
  if (usedFuncIdxs.size === 0) return;

  // Allocate a local for each unique string thunk and build the mapping
  const cacheMap = new Map<number, number>(); // funcIdx → local index
  for (const funcIdx of usedFuncIdxs) {
    const localIdx = allocLocal(fctx, `__cached_str_${funcIdx}`, {
      kind: "externref",
    });
    cacheMap.set(funcIdx, localIdx);
  }

  // Build the cache-loading preamble (call + local.set for each)
  const preamble: Instr[] = [];
  for (const [funcIdx, localIdx] of cacheMap) {
    preamble.push({ op: "call", funcIdx });
    preamble.push({ op: "local.set", index: localIdx });
  }

  // Replace all matching call instructions in the body with local.get
  replaceStringCalls(fctx.body, cacheMap);

  // Prepend the preamble at the start of the body
  fctx.body.unshift(...preamble);
}

/** Recursively scan instructions to find call instructions targeting string thunks. */
function collectStringCalls(
  instrs: Instr[],
  strFuncIdxSet: Set<number>,
  found: Set<number>,
): void {
  for (const instr of instrs) {
    if (instr.op === "call" && strFuncIdxSet.has(instr.funcIdx)) {
      found.add(instr.funcIdx);
    }
    // Recurse into nested blocks
    if (instr.op === "block" || instr.op === "loop") {
      collectStringCalls(instr.body, strFuncIdxSet, found);
    } else if (instr.op === "if") {
      collectStringCalls(instr.then, strFuncIdxSet, found);
      if (instr.else) collectStringCalls(instr.else, strFuncIdxSet, found);
    } else if (instr.op === "try") {
      collectStringCalls(instr.body, strFuncIdxSet, found);
      for (const c of instr.catches) {
        collectStringCalls(c.body, strFuncIdxSet, found);
      }
      if (instr.catchAll) collectStringCalls(instr.catchAll, strFuncIdxSet, found);
    }
  }
}

/** Recursively replace call instructions matching the cache map with local.get. */
function replaceStringCalls(
  instrs: Instr[],
  cacheMap: Map<number, number>,
): void {
  for (let i = 0; i < instrs.length; i++) {
    const instr = instrs[i]!;
    if (instr.op === "call" && cacheMap.has(instr.funcIdx)) {
      // Replace in-place: swap the call with a local.get
      const localIdx = cacheMap.get(instr.funcIdx)!;
      (instrs as any)[i] = { op: "local.get", index: localIdx };
    }
    // Recurse into nested blocks
    if (instr.op === "block" || instr.op === "loop") {
      replaceStringCalls(instr.body, cacheMap);
    } else if (instr.op === "if") {
      replaceStringCalls(instr.then, cacheMap);
      if (instr.else) replaceStringCalls(instr.else, cacheMap);
    } else if (instr.op === "try") {
      replaceStringCalls(instr.body, cacheMap);
      for (const c of instr.catches) {
        replaceStringCalls(c.body, cacheMap);
      }
      if (instr.catchAll) replaceStringCalls(instr.catchAll, cacheMap);
    }
  }
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return (
    modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
}

function hasDeclareModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return (
    modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false
  );
}

function hasAsyncModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

function hasAbstractModifier(node: ts.Node): boolean {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) &
      ts.ModifierFlags.Abstract) !==
    0
  );
}

function hasStaticModifier(node: ts.Node): boolean {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) &
      ts.ModifierFlags.Static) !==
    0
  );
}

/** Check if a function declaration is a generator (function*) */
function isGeneratorFunction(node: ts.FunctionDeclaration): boolean {
  return node.asteriskToken !== undefined;
}

/**
 * Unwrap Generator<T> return type to get the yield element type T.
 * Falls back to externref if the type cannot be unwrapped.
 */
function unwrapGeneratorYieldType(type: ts.Type, ctx: CodegenContext): ValType {
  const symbol = type.getSymbol();
  if (symbol && symbol.name === "Generator") {
    const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
    if (typeArgs.length > 0) {
      return resolveWasmType(ctx, typeArgs[0]!);
    }
  }
  // Also check Iterator and IterableIterator
  if (symbol && (symbol.name === "Iterator" || symbol.name === "IterableIterator")) {
    const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
    if (typeArgs.length > 0) {
      return resolveWasmType(ctx, typeArgs[0]!);
    }
  }
  // Fallback: assume number yield type (most common case)
  return { kind: "f64" };
}

/**
 * Ensure the stack top is an i32 suitable for use as a condition.
 * Handles: f64 (truthy != 0), externref (JS truthiness via __is_truthy), null (push 0).
 */
export function ensureI32Condition(
  fctx: FunctionContext,
  condType: ValType | null,
  ctx?: CodegenContext,
): void {
  if (!condType) {
    // Expression compilation failed — push false to keep Wasm valid
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }
  if (condType.kind === "f64") {
    // Use f64.abs + f64.gt(0) so that NaN, +0, and -0 are all falsy
    // (f64.ne(0) treats NaN as truthy which is wrong for JS semantics)
    fctx.body.push({ op: "f64.abs" });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.gt" });
  } else if (condType.kind === "externref") {
    // Use __is_truthy for proper JS truthiness (0, NaN, null, undefined, "" → falsy)
    if (ctx) {
      addUnionImports(ctx);
      const funcIdx = ctx.funcMap.get("__is_truthy");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    // Fallback: non-null → true
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
  } else if (condType.kind === "ref" || condType.kind === "ref_null") {
    // Boxed any value — use __any_unbox_bool for proper JS truthiness
    if (ctx && isAnyValue(condType, ctx)) {
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_unbox_bool");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    // Native string or struct ref — non-empty string is truthy
    // For strings: check length > 0 via string.measure_utf8 or ref.is_null fallback
    if (ctx && condType.typeIdx === ctx.anyStrTypeIdx) {
      // Native string — check length > 0
      const lengthIdx = ctx.nativeStrHelpers.get("__str_flatten");
      if (lengthIdx !== undefined) {
        // Flatten then check len field
        fctx.body.push({ op: "call", funcIdx: lengthIdx });
        fctx.body.push({
          op: "struct.get",
          typeIdx: ctx.nativeStrTypeIdx,
          fieldIdx: 0,
        }); // len field
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.gt_s" });
        return;
      }
    }
    // Fallback: non-null → true
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
  }
  else if (condType.kind === "i64") {
    // i64 truthiness: nonzero → true
    fctx.body.push({ op: "i64.eqz" } as unknown as Instr);
    fctx.body.push({ op: "i32.eqz" });
  }
  // i32 is already valid as-is
}

/** Get source position from a TS AST node (returns undefined if sourceMap is disabled) */
export function getSourcePos(
  ctx: CodegenContext,
  node: ts.Node,
): SourcePos | undefined {
  if (!ctx.sourceMap) return undefined;
  try {
    const sf = node.getSourceFile();
    if (!sf) return undefined;
    const pos = sf.getLineAndCharacterOfPosition(node.getStart());
    return { file: sf.fileName, line: pos.line, column: pos.character };
  } catch {
    return undefined;
  }
}

/** Attach a source position to an instruction (mutates in place) */
export function attachSourcePos(
  instr: Instr,
  sourcePos: SourcePos | undefined,
): Instr {
  if (sourcePos) {
    (instr as Instr).sourcePos = sourcePos;
  }
  return instr;
}

export { compileExpression } from "./expressions.js";
export { compileStatement } from "./statements.js";
