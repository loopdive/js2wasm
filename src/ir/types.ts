// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
export interface ExternClassMeta {
  importPrefix: string;
  namespacePath: string[];
  className: string;
  constructorParams: ValType[];
  methods: Map<string, { params: ValType[]; results: ValType[] }>;
  properties: Map<string, { type: ValType; readonly: boolean }>;
}

export interface WasmModule {
  types: TypeDef[];
  imports: Import[];
  functions: WasmFunction[];
  exports: WasmExport[];
  tables: Table[];
  elements: Element[];
  globals: GlobalDef[];
  tags: TagDef[];
  stringPool: string[];
  /** Extern class metadata (for .d.ts and imports helper generation) */
  externClasses: ExternClassMeta[];
  /** Map from import func name → string literal value (e.g. "__str_0" → "Hello") */
  stringLiteralValues: Map<string, string>;
  /** Set of function names that are async (for .d.ts generation) */
  asyncFunctions: Set<string>;
  /** Function indices referenced by ref.func that need declarative element segments */
  declaredFuncRefs: number[];
  /** Linear memory definitions */
  memories: { min: number; max?: number }[];
  /** Data segments for linear memory (string literals, etc.) */
  dataSegments: { offset: number; bytes: Uint8Array }[];
  /** Whether the module has top-level executable statements (module init code) */
  hasTopLevelStatements?: boolean;
}

export type TypeDef = FuncTypeDef | StructTypeDef | ArrayTypeDef | RecGroupDef | SubTypeDef;

export interface FuncTypeDef {
  kind: "func";
  name?: string;
  params: ValType[];
  results: ValType[];
}
export interface StructTypeDef {
  kind: "struct";
  name: string;
  fields: FieldDef[];
  /** Type index of the parent struct (for class inheritance sub-typing) */
  superTypeIdx?: number;
  /** When true and superTypeIdx is set, emit sub_final instead of sub (leaf types in hierarchy) */
  final?: boolean;
}
export interface ArrayTypeDef {
  kind: "array";
  name: string;
  element: ValType;
  mutable: boolean;
}
export interface RecGroupDef {
  kind: "rec";
  types: TypeDef[];
}
export interface SubTypeDef {
  kind: "sub";
  name: string;
  superType: number | null;
  final: boolean;
  type: StructTypeDef | ArrayTypeDef | FuncTypeDef;
}
export interface FieldDef {
  name: string;
  type: ValType;
  mutable: boolean;
}

export type ValType =
  | { kind: "i32" }
  | { kind: "i64" }
  | { kind: "f32" }
  | { kind: "f64" }
  | { kind: "v128" }
  | { kind: "i8" }
  | { kind: "i16" }
  | { kind: "ref"; typeIdx: number }
  | { kind: "ref_null"; typeIdx: number }
  | { kind: "funcref" }
  | { kind: "externref" }
  | { kind: "ref_extern" }
  | { kind: "eqref" }
  | { kind: "anyref" };

export interface WasmFunction {
  name: string;
  typeIdx: number;
  locals: LocalDef[];
  body: Instr[];
  exported: boolean;
}

export interface LocalDef {
  name: string;
  type: ValType;
}

/** Source position for source map generation */
export interface SourcePos {
  file: string;
  line: number;
  column: number;
}

type InstrBase =
  | { op: "local.get"; index: number }
  | { op: "local.set"; index: number }
  | { op: "local.tee"; index: number }
  | { op: "global.get"; index: number }
  | { op: "global.set"; index: number }
  | { op: "i32.const"; value: number }
  | { op: "i64.const"; value: bigint }
  | { op: "i64.add" }
  | { op: "i64.sub" }
  | { op: "i64.mul" }
  | { op: "i64.div_s" }
  | { op: "i64.rem_s" }
  | { op: "i64.eq" }
  | { op: "i64.ne" }
  | { op: "i64.lt_s" }
  | { op: "i64.le_s" }
  | { op: "i64.gt_s" }
  | { op: "i64.ge_s" }
  | { op: "i64.eqz" }
  | { op: "i64.and" }
  | { op: "i64.or" }
  | { op: "i64.xor" }
  | { op: "i64.shl" }
  | { op: "i64.shr_s" }
  | { op: "i64.shr_u" }
  | { op: "i64.extend_i32_s" }
  | { op: "i64.extend_i32_u" }
  | { op: "i64.trunc_f64_s" }
  | { op: "i64.reinterpret_f64" }
  | { op: "f64.convert_i64_s" }
  | { op: "f64.reinterpret_i64" }
  | { op: "f64.const"; value: number }
  | { op: "f32.const"; value: number }
  | { op: "i32.add" }
  | { op: "i32.sub" }
  | { op: "i32.mul" }
  | { op: "i32.eq" }
  | { op: "i32.ne" }
  | { op: "i32.lt_s" }
  | { op: "i32.le_s" }
  | { op: "i32.gt_s" }
  | { op: "i32.ge_s" }
  | { op: "i32.ge_u" }
  | { op: "i32.eqz" }
  | { op: "i32.and" }
  | { op: "i32.or" }
  | { op: "i32.xor" }
  | { op: "i32.shl" }
  | { op: "i32.shr_s" }
  | { op: "i32.shr_u" }
  | { op: "i32.clz" }
  | { op: "i32.wrap_i64" }
  | { op: "i32.trunc_f64_u" }
  | { op: "i32.trunc_sat_f64_s" }
  | { op: "i32.trunc_sat_f64_u" }
  | { op: "i64.trunc_sat_f64_s" }
  | { op: "f64.add" }
  | { op: "f64.sub" }
  | { op: "f64.mul" }
  | { op: "f64.div" }
  | { op: "f64.eq" }
  | { op: "f64.ne" }
  | { op: "f64.lt" }
  | { op: "f64.le" }
  | { op: "f64.gt" }
  | { op: "f64.ge" }
  | { op: "f64.sqrt" }
  | { op: "f64.abs" }
  | { op: "f64.neg" }
  | { op: "f64.floor" }
  | { op: "f64.ceil" }
  | { op: "f64.trunc" }
  | { op: "f64.nearest" }
  | { op: "f64.copysign" }
  | { op: "f64.min" }
  | { op: "f64.max" }
  | { op: "i32.trunc_f64_s" }
  | { op: "f64.convert_i32_s" }
  | { op: "f64.convert_i32_u" }
  | { op: "block"; blockType: BlockType; body: Instr[] }
  | { op: "loop"; blockType: BlockType; body: Instr[] }
  | { op: "if"; blockType: BlockType; then: Instr[]; else?: Instr[] }
  | { op: "br"; depth: number }
  | { op: "br_if"; depth: number }
  | { op: "br_table" }
  | { op: "return" }
  | { op: "end" }
  | { op: "call"; funcIdx: number }
  | { op: "return_call"; funcIdx: number }
  | { op: "call_indirect"; typeIdx: number; tableIdx: number }
  | { op: "drop" }
  | { op: "select" }
  | { op: "unreachable" }
  | { op: "nop" }
  | { op: "struct.new"; typeIdx: number }
  | { op: "struct.get"; typeIdx: number; fieldIdx: number }
  | { op: "struct.set"; typeIdx: number; fieldIdx: number }
  | { op: "array.new"; typeIdx: number }
  | { op: "array.new_fixed"; typeIdx: number; length: number }
  | { op: "array.new_default"; typeIdx: number }
  | { op: "array.get"; typeIdx: number }
  | { op: "array.get_s"; typeIdx: number }
  | { op: "array.get_u"; typeIdx: number }
  | { op: "array.set"; typeIdx: number }
  | { op: "array.len" }
  | { op: "array.copy"; dstTypeIdx: number; srcTypeIdx: number }
  | { op: "array.fill"; typeIdx: number }
  | { op: "ref.null"; typeIdx: number }
  | { op: "ref.null.extern" }
  | { op: "ref.null.eq" }
  | { op: "ref.null.func" }
  | { op: "ref.is_null" }
  | { op: "ref.as_non_null" }
  | { op: "ref.cast"; typeIdx: number }
  | { op: "ref.cast_null"; typeIdx: number }
  | { op: "ref.test"; typeIdx: number }
  | { op: "ref.eq" }
  | { op: "ref.func"; funcIdx: number }
  | { op: "call_ref"; typeIdx: number }
  | { op: "return_call_ref"; typeIdx: number }
  | { op: "memory.size" }
  | { op: "memory.grow" }
  | { op: "try"; blockType: BlockType; body: Instr[]; catches: CatchClause[]; catchAll?: Instr[] }
  | { op: "throw"; tagIdx: number }
  | { op: "rethrow"; depth: number }
  | { op: "any.convert_extern" }
  | { op: "extern.convert_any" }
  // Memory load/store (linear memory)
  | { op: "i32.load"; align: number; offset: number }
  | { op: "i32.load8_u"; align: number; offset: number }
  | { op: "i32.load8_s"; align: number; offset: number }
  | { op: "i32.load16_u"; align: number; offset: number }
  | { op: "i32.store"; align: number; offset: number }
  | { op: "i32.store8"; align: number; offset: number }
  | { op: "i32.store16"; align: number; offset: number }
  // Integer division and remainder
  | { op: "i32.div_u" }
  | { op: "i32.div_s" }
  | { op: "i32.rem_u" }
  | { op: "i32.rem_s" }
  // Unsigned comparisons (complements existing i32.lt_s etc.)
  | { op: "i32.lt_u" }
  | { op: "i32.le_u" }
  | { op: "i32.gt_u" }
  // f64 memory load/store (linear memory)
  | { op: "f64.load"; align: number; offset: number }
  | { op: "f64.store"; align: number; offset: number }
  // f32 memory load/store and conversion (linear memory)
  | { op: "f32.load"; align: number; offset: number }
  | { op: "f32.store"; align: number; offset: number }
  | { op: "f32.demote_f64" }
  | { op: "f64.promote_f32" }
  // SIMD v128 instructions
  | { op: "v128.const"; bytes: Uint8Array }
  | { op: "v128.load"; align: number; offset: number }
  | { op: "v128.store"; align: number; offset: number }
  | { op: "v128.not" }
  | { op: "v128.and" }
  | { op: "v128.andnot" }
  | { op: "v128.or" }
  | { op: "v128.xor" }
  | { op: "v128.bitselect" }
  | { op: "v128.any_true" }
  // i8x16
  | { op: "i8x16.splat" }
  | { op: "i8x16.extract_lane_s"; lane: number }
  | { op: "i8x16.extract_lane_u"; lane: number }
  | { op: "i8x16.replace_lane"; lane: number }
  | { op: "i8x16.eq" }
  | { op: "i8x16.ne" }
  | { op: "i8x16.all_true" }
  | { op: "i8x16.bitmask" }
  | { op: "i8x16.swizzle" }
  | { op: "i8x16.shuffle"; lanes: number[] }
  | { op: "i8x16.add" }
  | { op: "i8x16.sub" }
  | { op: "i8x16.min_u" }
  | { op: "i8x16.max_u" }
  // i16x8
  | { op: "i16x8.splat" }
  | { op: "i16x8.extract_lane_s"; lane: number }
  | { op: "i16x8.extract_lane_u"; lane: number }
  | { op: "i16x8.replace_lane"; lane: number }
  | { op: "i16x8.eq" }
  | { op: "i16x8.ne" }
  | { op: "i16x8.lt_s" }
  | { op: "i16x8.gt_s" }
  | { op: "i16x8.all_true" }
  | { op: "i16x8.bitmask" }
  | { op: "i16x8.add" }
  | { op: "i16x8.sub" }
  | { op: "i16x8.mul" }
  | { op: "i16x8.shl" }
  | { op: "i16x8.shr_u" }
  // i32x4
  | { op: "i32x4.splat" }
  | { op: "i32x4.extract_lane"; lane: number }
  | { op: "i32x4.replace_lane"; lane: number }
  | { op: "i32x4.eq" }
  | { op: "i32x4.ne" }
  | { op: "i32x4.all_true" }
  | { op: "i32x4.bitmask" }
  | { op: "i32x4.add" }
  | { op: "i32x4.sub" }
  | { op: "i32x4.mul" }
  | { op: "i32x4.shl" }
  | { op: "i32x4.shr_s" }
  | { op: "i32x4.shr_u" }
  // i64x2
  | { op: "i64x2.splat" }
  | { op: "i64x2.extract_lane"; lane: number }
  | { op: "i64x2.replace_lane"; lane: number }
  | { op: "i64x2.add" }
  | { op: "i64x2.sub" }
  | { op: "i64x2.mul" }
  | { op: "i64x2.eq" }
  | { op: "i64x2.ne" }
  // f32x4
  | { op: "f32x4.splat" }
  | { op: "f32x4.extract_lane"; lane: number }
  | { op: "f32x4.replace_lane"; lane: number }
  | { op: "f32x4.eq" }
  | { op: "f32x4.add" }
  | { op: "f32x4.sub" }
  | { op: "f32x4.mul" }
  | { op: "f32x4.div" }
  // f64x2
  | { op: "f64x2.splat" }
  | { op: "f64x2.extract_lane"; lane: number }
  | { op: "f64x2.replace_lane"; lane: number }
  | { op: "f64x2.eq" }
  | { op: "f64x2.ne" }
  | { op: "f64x2.add" }
  | { op: "f64x2.sub" }
  | { op: "f64x2.mul" }
  | { op: "f64x2.div" }
  // SIMD load/store lane
  | { op: "v128.load8_splat"; align: number; offset: number }
  | { op: "v128.load16_splat"; align: number; offset: number }
  | { op: "v128.load32_splat"; align: number; offset: number }
  | { op: "v128.load64_splat"; align: number; offset: number }
  | { op: "v128.load32_zero"; align: number; offset: number }
  | { op: "v128.load64_zero"; align: number; offset: number };

export type Instr = InstrBase & { sourcePos?: SourcePos };

export type BlockType = { kind: "empty" } | { kind: "val"; type: ValType } | { kind: "type"; typeIdx: number };

export interface CatchClause {
  tagIdx: number;
  body: Instr[];
}

export interface TagDef {
  name: string;
  /** Type index of the tag's function signature (params = exception values) */
  typeIdx: number;
}

export interface Import {
  module: string;
  name: string;
  desc: ImportDesc;
}
export type ImportDesc =
  | { kind: "func"; typeIdx: number }
  | { kind: "table"; elementType: string; min: number; max?: number }
  | { kind: "global"; type: ValType; mutable: boolean }
  | { kind: "tag"; typeIdx: number };

export interface WasmExport {
  name: string;
  desc: { kind: "func" | "table" | "memory" | "global" | "tag"; index: number };
}
export interface Table {
  elementType: string;
  min: number;
  max?: number;
}
export interface Element {
  tableIdx: number;
  offset: Instr[];
  funcIndices: number[];
}
export interface GlobalDef {
  name: string;
  type: ValType;
  mutable: boolean;
  init: Instr[];
}

export function createEmptyModule(): WasmModule {
  return {
    types: [],
    imports: [],
    functions: [],
    exports: [],
    tables: [],
    elements: [],
    globals: [],
    tags: [],
    stringPool: [],
    externClasses: [],
    stringLiteralValues: new Map(),
    asyncFunctions: new Set(),
    declaredFuncRefs: [],
    memories: [],
    dataSegments: [],
  };
}
