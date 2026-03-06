import ts from "typescript";
import type {
  Instr,
  LocalDef,
  ValType,
  WasmModule,
} from "../ir/types.js";
import type { ClassLayout } from "./layout.js";

/** Module-level context for linear-memory codegen */
export interface LinearContext {
  mod: WasmModule;
  checker: ts.TypeChecker;
  /** Map from function name to its absolute index (imports + locals) */
  funcMap: Map<string, number>;
  /** Number of imported functions */
  numImportFuncs: number;
  /** Current function context (set during function compilation) */
  currentFunc: LinearFuncContext | null;
  /** Errors accumulated during codegen */
  errors: { message: string; line: number; column: number }[];
  /** Class layouts for class declarations */
  classLayouts: Map<string, ClassLayout>;
  /** String literal data segment: string value → data segment offset */
  stringLiterals: Map<string, number>;
  /** Current data segment write offset */
  dataSegmentOffset: number;
  /** Counter for generating unique lambda function names */
  lambdaCounter: number;
  /** Function indices to populate in the funcref table */
  tableEntries: number[];
  /** Global index for __closure_env (env pointer for closures) */
  closureEnvGlobalIdx: number;
  /** Module-level variables → wasm global index */
  moduleGlobals: Map<string, number>;
  /** Module-level collection types (for Set, Map, Array globals) */
  moduleCollectionTypes: Map<string, CollectionKind>;
}

/** Collection type tag for tracking variable types */
export type CollectionKind = "Array" | "Uint8Array" | "ArrayOrUint8Array" | "Map" | "Set";

/** Per-function context for linear-memory codegen */
export interface LinearFuncContext {
  /** Function name */
  name: string;
  /** Parameters (the first N locals) */
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
  /** Track which locals are collection types (varName → kind) */
  collectionTypes: Map<string, CollectionKind>;
  /** Parameters that are callback/function-typed (param name → call_indirect type index) */
  callbackParams: Map<string, number>;
}

/** Add a local variable to the current function context */
export function addLocal(
  fctx: LinearFuncContext,
  name: string,
  type: ValType,
): number {
  const index = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name, type });
  fctx.localMap.set(name, index);
  return index;
}
