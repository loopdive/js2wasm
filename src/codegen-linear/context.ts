import ts from "typescript";
import type {
  Instr,
  LocalDef,
  ValType,
  WasmModule,
} from "../ir/types.js";

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
}

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
