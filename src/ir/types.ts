export interface WasmModule {
  types: TypeDef[];
  imports: Import[];
  functions: WasmFunction[];
  exports: WasmExport[];
  tables: Table[];
  elements: Element[];
  globals: GlobalDef[];
  stringPool: string[];
}

export type TypeDef =
  | FuncTypeDef
  | StructTypeDef
  | ArrayTypeDef
  | RecGroupDef
  | SubTypeDef;

export interface FuncTypeDef {
  kind: "func";
  name: string;
  params: ValType[];
  results: ValType[];
}
export interface StructTypeDef {
  kind: "struct";
  name: string;
  fields: FieldDef[];
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
  type: StructTypeDef | ArrayTypeDef;
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
  | { kind: "ref"; typeIdx: number }
  | { kind: "ref_null"; typeIdx: number }
  | { kind: "funcref" }
  | { kind: "externref" };

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

export type Instr =
  | { op: "local.get"; index: number }
  | { op: "local.set"; index: number }
  | { op: "local.tee"; index: number }
  | { op: "global.get"; index: number }
  | { op: "global.set"; index: number }
  | { op: "i32.const"; value: number }
  | { op: "i64.const"; value: bigint }
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
  | { op: "i32.trunc_f64_s" }
  | { op: "f64.convert_i32_s" }
  | { op: "block"; blockType: BlockType; body: Instr[] }
  | { op: "loop"; blockType: BlockType; body: Instr[] }
  | { op: "if"; blockType: BlockType; then: Instr[]; else?: Instr[] }
  | { op: "br"; depth: number }
  | { op: "br_if"; depth: number }
  | { op: "return" }
  | { op: "call"; funcIdx: number }
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
  | { op: "array.set"; typeIdx: number }
  | { op: "array.len" }
  | { op: "ref.null"; typeIdx: number }
  | { op: "ref.null.extern" }
  | { op: "ref.is_null" }
  | { op: "ref.as_non_null" }
  | { op: "ref.cast"; typeIdx: number }
  | { op: "ref.test"; typeIdx: number }
  | { op: "ref.eq" }
  | { op: "memory.size" }
  | { op: "memory.grow" };

export type BlockType =
  | { kind: "empty" }
  | { kind: "val"; type: ValType }
  | { kind: "type"; typeIdx: number };

export interface Import {
  module: string;
  name: string;
  desc: ImportDesc;
}
export type ImportDesc =
  | { kind: "func"; typeIdx: number }
  | { kind: "table"; elementType: string; min: number; max?: number }
  | { kind: "global"; type: ValType; mutable: boolean };

export interface WasmExport {
  name: string;
  desc: { kind: "func" | "table" | "memory" | "global"; index: number };
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
    stringPool: [],
  };
}
