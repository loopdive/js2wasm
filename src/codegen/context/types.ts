// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared backend context and metadata types.
 *
 * This module owns the stable type layer for the codegen backend so leaf
 * modules do not need to import the monolithic `codegen/index.ts` file just
 * to reference context/state shapes.
 */
import ts from "typescript";
import type { FieldDef, Instr, LocalDef, SourcePos, ValType, WasmModule } from "../../ir/types.js";

export interface CodegenError {
  message: string;
  line: number;
  column: number;
  severity?: "error" | "warning";
}

/** Result returned by generateModule / generateMultiModule. */
export interface CodegenResult {
  module: WasmModule;
  errors: CodegenError[];
}

/** Public options for backend code generation. */
export interface CodegenOptions {
  /** Whether to generate source positions for source map */
  sourceMap?: boolean;
  /** Fast mode: i32 default numbers */
  fast?: boolean;
  /** Use WasmGC-native strings instead of wasm:js-string imports */
  nativeStrings?: boolean;
  /** WASI target: emit WASI imports (fd_write, proc_exit) instead of JS host imports */
  wasi?: boolean;
  /** Set of function names imported from node:fs (detected pre-preprocessing) */
  wasiNodeFsFuncs?: Set<string>;
}

/** Info about an externally declared class. */
export interface ExternClassInfo {
  importPrefix: string;
  namespacePath: string[];
  className: string;
  constructorParams: ValType[];
  methods: Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>;
  properties: Map<string, { type: ValType; readonly: boolean }>;
}

/** Info about an optional parameter. */
export interface OptionalParamInfo {
  index: number;
  type: ValType;
  /** If the default is a compile-time constant, its value is stored here. */
  constantDefault?: { kind: "f64"; value: number } | { kind: "i32"; value: number };
  /** True when the default is a non-constant expression (needs callee-side evaluation). */
  hasExpressionDefault?: boolean;
}

/** Info about a rest parameter. */
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

/** Metadata for a function eligible for call-site inlining. */
export interface InlinableFunctionInfo {
  /** The compiled body instructions (shallow copy, safe to re-emit) */
  body: Instr[];
  /** Number of parameters */
  paramCount: number;
  /** Parameter types (for allocating temp locals) */
  paramTypes: ValType[];
  /** Return type (null = void) */
  returnType: ValType | null;
}

/** Metadata for a closure stored in a local variable. */
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

/** Per-function context. */
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
  /** Whether this constructor belongs to a class declared with `extends`. Spec §10.2.1.3
   * step 13c requires a derived constructor that returns a non-object, non-undefined
   * value to throw TypeError instead of silently coercing and null-dereffing. */
  isDerivedConstructor?: boolean;
  /** Whether this function is a generator (function*) */
  isGenerator?: boolean;
  /** Set of variable names that are read-only bindings (e.g. named function expression name) */
  readOnlyBindings?: Set<string>;
  /** Set of variable names that are const bindings — assignment throws TypeError at runtime */
  constBindings?: Set<string>;
  /** Stack of saved body arrays for addUnionImports index shifting */
  savedBodies: Instr[][];
  /** Set of function names successfully hoisted during THIS function body's hoisting pass */
  hoistedFuncs?: Set<string>;
  /** Enclosing class name — propagated to closures for super keyword resolution */
  enclosingClassName?: string;
  /** Set of variable names known to be non-null in the current scope (type narrowing) */
  narrowedNonNull?: Set<string>;
  /**
   * Set of "arrayVar:indexVar" keys where bounds checks can be elided.
   * Populated when a for-loop condition guarantees indexVar < arrayVar.length.
   */
  safeIndexedArrays?: Set<string>;
  /**
   * Free list for temporary locals, keyed by ValType key string.
   * Used by allocTempLocal/releaseTempLocal to reuse locals of the same type.
   */
  tempFreeList?: Map<string, number[]>;
  /** Map from let/const local variable name → local index of its i32 TDZ flag (0 = uninitialized) */
  tdzFlagLocals?: Map<string, number>;
  /**
   * Stack of catch rethrow info. Each entry tracks a catch variable name and the
   * current depth (number of block-like structures) from the catch boundary.
   */
  catchRethrowStack?: { varName: string; depth: number }[];
  /**
   * Stack of pending finally blocks. When a return/break/continue exits a try
   * block that has a finally clause, the finally instructions must be inlined
   * before the control-flow transfer.
   */
  finallyStack?: {
    cloneFinally: () => Instr[];
    breakStackLen: number;
    continueStackLen: number;
  }[];
  /**
   * Pending writeback instructions for mutable callback captures (#859).
   */
  pendingCallbackWritebacks?: Instr[];
  /**
   * Persistent writeback instructions for getter/setter callbacks (#929).
   * Unlike pendingCallbackWritebacks (one-shot), these are re-emitted after
   * every call expression so that mutations from deferred callback invocations
   * (e.g. Object.defineProperty getter called later by Object.defineProperties)
   * are reflected in the outer scope's local variables.
   */
  persistentCallbackWritebacks?: Instr[];
  /**
   * Mapped arguments info for non-strict functions with simple parameters (#849).
   */
  mappedArgsInfo?: {
    argsLocalIdx: number;
    arrTypeIdx: number;
    vecTypeIdx: number;
    paramCount: number;
    paramOffset: number;
    paramTypes: ValType[];
  };
}

/** Context shared across all codegen. */
export interface CodegenContext {
  mod: WasmModule;
  checker: ts.TypeChecker;
  /** Map from function name to its absolute index (imports + locals) */
  funcMap: Map<string, number>;
  /** Map from struct/interface name to type index */
  structMap: Map<string, number>;
  /** Reverse map from type index to struct/interface name (O(1) reverse lookup) */
  typeIdxToStructName: Map<number, string>;
  /** Map from struct name to field info */
  structFields: Map<string, FieldDef[]>;
  /** Number of imported functions */
  numImportFuncs: number;
  /** wasm:js-string import indices — separate from funcMap to prevent
   *  user-defined functions from shadowing them (#1072). */
  jsStringImports: Map<string, number>;
  /** Current function context (set during function compilation) */
  currentFunc: FunctionContext | null;
  /** Stack of parent function contexts saved during nested closure compilation. */
  funcStack: FunctionContext[];
  /** Errors accumulated during codegen */
  errors: CodegenError[];
  /** Last AST node with a valid source position — used as fallback for error reporting
   * when the immediate node lacks source file context (synthetic/detached nodes). */
  lastKnownNode: ts.Node | null;
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
  /** Map from string literal value → global import index */
  stringGlobalMap: Map<string, number>;
  /** Number of imported globals (string constants) */
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
  /** Classes that must throw TypeError at evaluation time */
  classThrowsOnEval: Set<string>;
  /** Map from "ClassName_methodName" → method info for local classes */
  classMethodSet: Set<string>;
  /** Classes inside function bodies whose body compilation is deferred */
  deferredClassBodies: Set<string>;
  /** Set of "ClassName_propName" for getter/setter accessor properties */
  classAccessorSet: Set<string>;
  /** Set of "ClassName_propName" for static getter/setter accessor properties */
  staticAccessorSet: Set<string>;
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
  /**
   * Functions whose body reads `arguments`. Used by callers to decide
   * whether to populate the `__extras_argv` module global with extra
   * runtime args beyond the formal param count (#1053).
   */
  funcUsesArguments: Set<string>;
  /**
   * Module global index for the runtime extras argv vec (#1053).
   * Lazily registered on first use; -1 if not yet created.
   * Type: (mut (ref null $vec_externref))
   */
  extrasArgvGlobalIdx: number;
  /** Vec struct type index for the extras argv global (matches externref vec type). */
  extrasArgvVecTypeIdx: number;
  /**
   * Absolute Wasm global index for the `__argc` (mut i32) module global.
   * Set by the caller to communicate the actual call-site argument count
   * to functions that use `arguments`. -1 = not yet created.
   */
  argcGlobalIdx: number;
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
  /** Map from generator function name → yield element type */
  generatorYieldType: Map<string, ValType>;
  /** Map from module-level variable name → global index in mod.globals */
  moduleGlobals: Map<string, number>;
  /** Deferred `export default <variable>` where variable is a module global (#1108).
   *  Resolved after all collectDeclarations calls when global indices are final. */
  deferredDefaultGlobalExport?: string;
  /** Module-level variable initializers (compiled into __module_init) */
  moduleInitStatements: ts.Statement[];
  /** Nested function capture info. */
  nestedFuncCaptures: Map<string, { name: string; outerLocalIdx: number; mutable?: boolean; valType?: ValType }[]>;
  /** Map from child className → parent className (for local class inheritance) */
  classParentMap: Map<string, string>;
  /** Counter for assigning unique class tags (for instanceof support) */
  classTagCounter: number;
  /** Map from class name → unique tag value (for instanceof support) */
  classTagMap: Map<string, number>;
  /** Map from TS symbol name → synthetic class name for class expressions */
  classExprNameMap: Map<string, string>;
  /** Map from ClassExpression AST node → synthetic class name */
  anonClassExprNames: Map<ts.ClassExpression, string>;
  /** Map from function/class identifier → its ES-spec .name string value */
  functionNameMap: Map<string, string>;
  /** Whether to attach source positions for source map generation */
  sourceMap: boolean;
  /** Map from tuple type signature key → type index of the tuple struct */
  tupleTypeMap: Map<string, number>;
  /** Fast mode: default number to i32, promote to f64 only when needed */
  fast: boolean;
  /** Use WasmGC-native strings instead of wasm:js-string imports */
  nativeStrings: boolean;
  /** Native string support type indices */
  nativeStrDataTypeIdx: number;
  anyStrTypeIdx: number;
  nativeStrTypeIdx: number;
  consStrTypeIdx: number;
  /** Whether native string helper functions have been emitted */
  nativeStrHelpersEmitted: boolean;
  /** Whether native string host bridge helpers have been emitted */
  nativeStrExternBridgeEmitted: boolean;
  /** Map from native string helper name → function index */
  nativeStrHelpers: Map<string, number>;
  /** Map from value type kind → ref cell struct type index */
  refCellTypeMap: Map<string, number>;
  /** Type index of the $AnyValue boxed-any struct */
  anyValueTypeIdx: number;
  /** Map from any-value helper name → function index */
  anyHelpers: Map<string, number>;
  /** Whether any-value helper functions have been emitted */
  anyHelpersEmitted: boolean;
  /** Shape-inferred array-like variables */
  shapeMap: Map<string, { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType }>;
  /** Set of function names that failed during hoisting pre-pass */
  hoistFailedFuncs?: Set<string>;
  /** Counter for unique tagged template cache global variables */
  templateCacheCounter: number;
  /** Type index for template vec struct */
  templateVecTypeIdx: number;
  /** Extra properties for empty object variables */
  widenedTypeProperties: Map<string, { name: string; type: ValType }[]>;
  /** Map from widened variable name to its registered struct name */
  widenedVarStructMap: Map<string, string>;
  /** Math methods that need inline Wasm implementations */
  pendingMathMethods: Set<string>;
  /** True if Math.clz32 or Math.imul is used — requires ToUint32 Wasm helper */
  needsToUint32: boolean;
  /** Map from class name → class AST declaration node */
  classDeclarationMap: Map<string, ts.ClassDeclaration | ts.ClassExpression>;
  /** Cache for function type deduplication: signature key → type index */
  funcTypeCache: Map<string, number>;
  /** Wrapper type indices */
  wrapperNumberTypeIdx: number;
  wrapperStringTypeIdx: number;
  wrapperBooleanTypeIdx: number;
  /** Cache for function reference wrappers: signature key → ClosureInfo */
  funcRefWrapperCache: Map<string, ClosureInfo>;
  /** Pending module-init body (not yet in mod.functions) that needs global index fixup */
  pendingInitBody: Instr[] | null;
  /** Map from function name to inlinable function info */
  inlinableFunctions: Map<string, InlinableFunctionInfo>;
  /** Global index of the __symbol_counter */
  symbolCounterGlobalIdx: number;
  /** Stack of in-progress parent function bodies for index shifting during closure compilation */
  parentBodiesStack: Instr[][];
  /** Hash-based lookup for anonymous struct deduplication */
  anonStructHash: Map<string, string>;
  /** Pending late import shift state */
  pendingLateImportShift: { importsBefore: number } | null;
  /** Map from class name → global index of the prototype externref singleton */
  protoGlobals: Map<string, number>;
  /** Map from class name → own method names (instance methods, for prototype allowlist; see #1047) */
  classMethodNames: Map<string, string[]>;
  /** Map from class name → global idx of the method-name CSV string constant (see #1047) */
  classMethodsCsvGlobal: Map<string, number>;
  /** Whether targeting WASI */
  wasi: boolean;
  /** WASI import indices */
  wasiFdWriteIdx: number;
  wasiProcExitIdx: number;
  wasiPathOpenIdx: number;
  wasiFdCloseIdx: number;
  wasiBumpPtrGlobalIdx: number;
  /** Set of node:fs functions used in WASI mode */
  wasiNodeFsFuncs: Set<string>;
  /** Map from let/const module global variable name → TDZ flag global index */
  tdzGlobals: Map<string, number>;
  /** Set of let/const module global variable names */
  tdzLetConstNames: Set<string>;
  /** Compile-time property descriptor flags */
  definedPropertyFlags: Map<string, number>;
  /** Object mutability state sets */
  nonExtensibleVars: Set<string>;
  frozenVars: Set<string>;
  sealedVars: Set<string>;
  /** Per-shape default property flags table */
  shapePropFlags: Map<number, Uint8Array>;
  /** Cache for function-constructor struct types */
  funcConstructorMap: Map<string, { structTypeIdx: number; ctorFuncName: string }>;
  /** Per-compilation recursion guard for ensureStructForType (prevents infinite loops on circular types) */
  ensureStructPending: Set<ts.Type>;
}

export type { SourcePos };
