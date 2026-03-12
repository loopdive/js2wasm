import type {
  WasmModule,
  TypeDef,
  ValType,
  Instr,
  BlockType,
  FieldDef,
  Import,
  WasmFunction,
  WasmExport,
  GlobalDef,
  CatchClause,
  TagDef,
  SourcePos,
} from "../ir/types.js";
import { WasmEncoder } from "./encoder.js";
import { OP, GC, TYPE, SECTION, SIMD } from "./opcodes.js";

/** A source map entry: maps a wasm byte offset to a source position */
export interface SourceMapEntry {
  wasmOffset: number;
  sourcePos: SourcePos;
}

/** Result of binary emission with source map data */
export interface EmitResult {
  binary: Uint8Array;
  sourceMapEntries: SourceMapEntry[];
}

/** Emit a complete Wasm binary from an IR module */
export function emitBinary(mod: WasmModule): Uint8Array {
  return emitBinaryWithSourceMap(mod).binary;
}

/** Emit a Wasm binary and collect source map entries */
export function emitBinaryWithSourceMap(mod: WasmModule): EmitResult {
  const enc = new WasmEncoder();
  const sourceMapEntries: SourceMapEntry[] = [];

  // Magic + Version
  enc.bytes([0x00, 0x61, 0x73, 0x6d]); // \0asm
  enc.bytes([0x01, 0x00, 0x00, 0x00]); // version 1

  const numImportFuncs = mod.imports.filter(
    (i) => i.desc.kind === "func",
  ).length;

  // Type section
  if (mod.types.length > 0) {
    enc.section(SECTION.type, (s) => {
      s.vector(mod.types, (t, e) => encodeTypeDef(t, e));
    });
  }

  // Import section
  if (mod.imports.length > 0) {
    enc.section(SECTION.import, (s) => {
      s.vector(mod.imports, (imp, e) => encodeImport(imp, e));
    });
  }

  // Function section (type indices for each function)
  if (mod.functions.length > 0) {
    enc.section(SECTION.function, (s) => {
      s.vector(mod.functions, (f, e) => e.u32(f.typeIdx));
    });
  }

  // Table section
  if (mod.tables.length > 0) {
    enc.section(SECTION.table, (s) => {
      s.vector(mod.tables, (t, e) => {
        e.byte(t.elementType === "funcref" ? TYPE.funcref : TYPE.externref);
        if (t.max !== undefined) {
          e.byte(0x01); // has max
          e.u32(t.min);
          e.u32(t.max);
        } else {
          e.byte(0x00);
          e.u32(t.min);
        }
      });
    });
  }

  // Memory section
  if (mod.memories && mod.memories.length > 0) {
    enc.section(SECTION.memory, (s) => {
      s.u32(mod.memories.length);
      for (const mem of mod.memories) {
        if (mem.max !== undefined) {
          s.byte(0x01);
          s.u32(mem.min);
          s.u32(mem.max);
        } else {
          s.byte(0x00);
          s.u32(mem.min);
        }
      }
    });
  }

  // Tag section (exception handling) — must come before Global section
  if (mod.tags.length > 0) {
    enc.section(SECTION.tag, (s) => {
      s.vector(mod.tags, (tag, e) => {
        e.byte(0x00); // attribute: exception (0)
        e.u32(tag.typeIdx);
      });
    });
  }

  // Global section
  if (mod.globals.length > 0) {
    enc.section(SECTION.global, (s) => {
      s.vector(mod.globals, (g, e) => encodeGlobal(g, e));
    });
  }

  // Export section
  if (mod.exports.length > 0) {
    enc.section(SECTION.export, (s) => {
      s.vector(mod.exports, (exp, e) => encodeExport(exp, e, numImportFuncs));
    });
  }

  // Element section — active segments (tables) + declarative segments (ref.func)
  const hasActiveElems = mod.elements.length > 0;
  const hasDeclaredRefs = mod.declaredFuncRefs.length > 0;
  if (hasActiveElems || hasDeclaredRefs) {
    enc.section(SECTION.element, (s) => {
      const totalSegments = mod.elements.length + (hasDeclaredRefs ? 1 : 0);
      s.u32(totalSegments);
      // Active element segments (table initializers)
      for (const elem of mod.elements) {
        s.byte(0x00); // active, table 0, funcref
        for (const instr of elem.offset) encodeInstr(instr, s);
        s.byte(OP.end);
        s.u32(elem.funcIndices.length);
        for (const idx of elem.funcIndices) s.u32(idx);
      }
      // Declarative element segment for ref.func targets
      if (hasDeclaredRefs) {
        s.byte(0x03); // declarative, elemkind
        s.byte(0x00); // elemkind = funcref
        s.u32(mod.declaredFuncRefs.length);
        for (const idx of mod.declaredFuncRefs) s.u32(idx);
      }
    });
  }

  // Code section — track byte offsets for source map
  if (mod.functions.length > 0) {
    // Build code section body to determine code section payload offset
    const codeSectionBody = new WasmEncoder();
    // Collect per-function relative offset entries
    const funcRelativeEntries: { bodyOffset: number; instrOffset: number; sourcePos: SourcePos }[] = [];

    codeSectionBody.u32(mod.functions.length); // vector count
    for (const f of mod.functions) {
      const bodyStartInSection = codeSectionBody.length;
      encodeFunctionWithSourceMap(f, codeSectionBody, bodyStartInSection, funcRelativeEntries);
    }

    const codeSectionData = codeSectionBody.finish();

    // Write the code section: id byte + length + data
    // The absolute offset of the code section payload within the final binary:
    // current enc.length + 1 (section id byte) + sizeof(u32(codeSectionData.length))
    const sectionIdPos = enc.length;
    enc.byte(SECTION.code);
    const lengthBefore = enc.length;
    enc.u32(codeSectionData.length);
    const codeSectionPayloadStart = enc.length;
    enc.bytes(codeSectionData);

    // Convert relative entries to absolute wasm byte offsets
    for (const entry of funcRelativeEntries) {
      sourceMapEntries.push({
        wasmOffset: codeSectionPayloadStart + entry.instrOffset,
        sourcePos: entry.sourcePos,
      });
    }
  }

  // Data section (active data segments for linear memory)
  if (mod.dataSegments && mod.dataSegments.length > 0) {
    enc.section(SECTION.data, (s) => {
      s.u32(mod.dataSegments.length);
      for (const seg of mod.dataSegments) {
        // Active data segment for memory 0
        s.byte(0x00); // active, memory index 0
        // Offset expression: i32.const <offset>; end
        s.byte(OP.i32_const);
        s.i32(seg.offset);
        s.byte(OP.end);
        // Data bytes
        s.u32(seg.bytes.length);
        s.bytes(seg.bytes);
      }
    });
  }

  // Custom "name" section — function names for debugging/treemap
  {
    const nameEntries: { index: number; name: string }[] = [];
    // Import functions
    let funcIdx = 0;
    for (const imp of mod.imports) {
      if (imp.desc.kind === "func") {
        nameEntries.push({ index: funcIdx, name: imp.name.replace(/_import$/, "") });
        funcIdx++;
      }
    }
    // Local functions
    for (const f of mod.functions) {
      if (f.name) {
        nameEntries.push({ index: funcIdx, name: f.name });
      }
      funcIdx++;
    }
    if (nameEntries.length > 0) {
      enc.section(SECTION.custom, (s) => {
        s.name("name");
        // Subsection 1: function names
        const sub = new WasmEncoder();
        sub.u32(nameEntries.length);
        for (const entry of nameEntries) {
          sub.u32(entry.index);
          sub.name(entry.name);
        }
        const subData = sub.finish();
        s.byte(1); // subsection id = 1 (function names)
        s.u32(subData.length);
        s.bytes(subData);
      });
    }
  }

  return { binary: enc.finish(), sourceMapEntries };
}

/** Encode a function body, tracking instruction offsets for source maps */
function encodeFunctionWithSourceMap(
  f: WasmFunction,
  enc: WasmEncoder,
  _bodyStartInSection: number,
  entries: { bodyOffset: number; instrOffset: number; sourcePos: SourcePos }[],
): void {
  const body = new WasmEncoder();

  // Locals: group consecutive same-type locals
  const localGroups = groupLocals(f.locals);
  body.vector(localGroups, (group, e) => {
    e.u32(group.count);
    encodeValType(group.type, e);
  });

  // Body instructions — track positions for instructions with sourcePos
  for (const instr of f.body) {
    encodeInstrWithSourceMap(instr, body, entries, _bodyStartInSection, enc);
  }
  body.byte(OP.end);

  const bodyBytes = body.finish();
  // The function body in the code section is: u32(bodyBytes.length) + bodyBytes
  // We need to account for the u32 prefix length when computing absolute offsets
  const u32PrefixSize = leb128UnsignedSize(bodyBytes.length);

  // Adjust all entries' instrOffset: add the position of the function body data within the section
  // entries that were just added have instrOffset relative to the body encoder
  // We need to adjust them to be relative to the section start
  for (const entry of entries) {
    if (entry.bodyOffset === _bodyStartInSection) {
      // This entry belongs to this function — adjust its instrOffset
      entry.instrOffset = _bodyStartInSection + u32PrefixSize + entry.instrOffset;
    }
  }

  enc.u32(bodyBytes.length);
  enc.bytes(bodyBytes);
}

/** Encode instruction and collect source positions */
function encodeInstrWithSourceMap(
  instr: Instr,
  enc: WasmEncoder,
  entries: { bodyOffset: number; instrOffset: number; sourcePos: SourcePos }[],
  bodyStartInSection: number,
  _sectionEnc: WasmEncoder,
): void {
  // Record source position before encoding the instruction
  if (instr.sourcePos) {
    entries.push({
      bodyOffset: bodyStartInSection,
      instrOffset: enc.length, // position within the body encoder
      sourcePos: instr.sourcePos,
    });
  }
  encodeInstr(instr, enc);
}

/** Calculate the byte size of an unsigned LEB128 encoding */
function leb128UnsignedSize(value: number): number {
  let size = 0;
  do {
    value >>>= 7;
    size++;
  } while (value !== 0);
  return size;
}

export function encodeTypeDef(t: TypeDef, enc: WasmEncoder): void {
  switch (t.kind) {
    case "func":
      enc.byte(TYPE.func);
      enc.vector(t.params, (p, e) => encodeValType(p, e));
      enc.vector(t.results, (r, e) => encodeValType(r, e));
      break;
    case "struct":
      if (t.superTypeIdx !== undefined) {
        // Wrap in sub-type encoding for class inheritance
        enc.byte(TYPE.sub); // 0x50 = non-final sub
        if (t.superTypeIdx >= 0) {
          enc.u32(1); // 1 supertype
          enc.u32(t.superTypeIdx);
        } else {
          enc.u32(0); // 0 supertypes (root of hierarchy, non-final)
        }
        enc.byte(TYPE.struct);
        enc.vector(t.fields, (f, e) => encodeFieldDef(f, e));
      } else {
        enc.byte(TYPE.struct);
        enc.vector(t.fields, (f, e) => encodeFieldDef(f, e));
      }
      break;
    case "array":
      enc.byte(TYPE.array);
      encodeStorageType(t.element, enc);
      enc.byte(t.mutable ? TYPE.mut_field : TYPE.const_field);
      break;
    case "rec":
      enc.byte(TYPE.rec);
      enc.u32(t.types.length);
      for (const sub of t.types) encodeTypeDef(sub, enc);
      break;
    case "sub":
      if (t.superType !== null) {
        enc.byte(t.final ? TYPE.sub_final : TYPE.sub);
        enc.u32(1); // 1 supertype
        enc.u32(t.superType);
      } else if (!t.final) {
        enc.byte(TYPE.sub);
        enc.u32(0); // 0 supertypes
      }
      // else: final with no super → just encode inner type
      if (t.superType !== null || !t.final) {
        encodeTypeDef(t.type, enc);
      } else {
        encodeTypeDef(t.type, enc);
      }
      break;
  }
}

export function encodeFieldDef(f: FieldDef, enc: WasmEncoder): void {
  encodeStorageType(f.type, enc);
  enc.byte(f.mutable ? TYPE.mut_field : TYPE.const_field);
}

export function encodeStorageType(t: ValType, enc: WasmEncoder): void {
  // Packed storage types (i8, i16) are only valid in struct fields and array elements
  if (t.kind === "i16") {
    enc.byte(TYPE.i16);
    return;
  }
  encodeValType(t, enc);
}

export function encodeValType(t: ValType, enc: WasmEncoder): void {
  switch (t.kind) {
    case "i32":
      enc.byte(TYPE.i32);
      break;
    case "i64":
      enc.byte(TYPE.i64);
      break;
    case "f32":
      enc.byte(TYPE.f32);
      break;
    case "f64":
      enc.byte(TYPE.f64);
      break;
    case "v128":
      enc.byte(TYPE.v128);
      break;
    case "funcref":
      enc.byte(TYPE.funcref);
      break;
    case "externref":
      enc.byte(TYPE.externref);
      break;
    case "ref_extern":
      enc.byte(TYPE.ref);
      enc.byte(TYPE.externref); // extern abstract heap type (-17 as s33)
      break;
    case "ref":
      enc.byte(TYPE.ref);
      enc.i32(t.typeIdx);
      break;
    case "ref_null":
      enc.byte(TYPE.ref_null);
      enc.i32(t.typeIdx);
      break;
    case "eqref":
      enc.byte(TYPE.ref_null);
      enc.byte(TYPE.eq);
      break;
    case "i16":
      // i16 is only valid as a packed storage type in struct fields/array elements,
      // but if it appears in encodeValType, encode it as i32 (this shouldn't happen)
      enc.byte(TYPE.i32);
      break;
  }
}

export function encodeImport(imp: Import, enc: WasmEncoder): void {
  enc.name(imp.module);
  enc.name(imp.name);
  switch (imp.desc.kind) {
    case "func":
      enc.byte(0x00);
      enc.u32(imp.desc.typeIdx);
      break;
    case "table":
      enc.byte(0x01);
      enc.byte(
        imp.desc.elementType === "funcref" ? TYPE.funcref : TYPE.externref,
      );
      if (imp.desc.max !== undefined) {
        enc.byte(0x01);
        enc.u32(imp.desc.min);
        enc.u32(imp.desc.max);
      } else {
        enc.byte(0x00);
        enc.u32(imp.desc.min);
      }
      break;
    case "global":
      enc.byte(0x03);
      encodeValType(imp.desc.type, enc);
      enc.byte(imp.desc.mutable ? 0x01 : 0x00);
      break;
    case "tag":
      enc.byte(0x04); // import kind: tag
      enc.byte(0x00); // attribute: exception
      enc.u32(imp.desc.typeIdx);
      break;
  }
}

export function encodeGlobal(g: GlobalDef, enc: WasmEncoder): void {
  encodeValType(g.type, enc);
  enc.byte(g.mutable ? 0x01 : 0x00);
  for (const instr of g.init) encodeInstr(instr, enc);
  enc.byte(OP.end);
}

export function encodeExport(
  exp: WasmExport,
  enc: WasmEncoder,
  _numImportFuncs: number,
): void {
  enc.name(exp.name);
  const kindByte =
    exp.desc.kind === "func"
      ? 0x00
      : exp.desc.kind === "table"
        ? 0x01
        : exp.desc.kind === "memory"
          ? 0x02
          : 0x03;
  enc.byte(kindByte);
  enc.u32(exp.desc.index);
}

export function encodeFunction(f: WasmFunction, enc: WasmEncoder): void {
  const body = new WasmEncoder();

  // Locals: group consecutive same-type locals
  const localGroups = groupLocals(f.locals);
  body.vector(localGroups, (group, e) => {
    e.u32(group.count);
    encodeValType(group.type, e);
  });

  // Body instructions
  for (const instr of f.body) {
    encodeInstr(instr, body);
  }
  body.byte(OP.end);

  const bodyBytes = body.finish();
  enc.u32(bodyBytes.length);
  enc.bytes(bodyBytes);
}

export interface LocalGroup {
  count: number;
  type: ValType;
}

export function groupLocals(locals: { type: ValType }[]): LocalGroup[] {
  const groups: LocalGroup[] = [];
  for (const local of locals) {
    const last = groups[groups.length - 1];
    if (last && valTypeEq(last.type, local.type)) {
      last.count++;
    } else {
      groups.push({ count: 1, type: local.type });
    }
  }
  return groups;
}

function valTypeEq(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if (
    (a.kind === "ref" || a.kind === "ref_null") &&
    (b.kind === "ref" || b.kind === "ref_null")
  ) {
    return a.typeIdx === b.typeIdx;
  }
  return true;
}

export function encodeBlockType(bt: BlockType, enc: WasmEncoder): void {
  switch (bt.kind) {
    case "empty":
      enc.byte(0x40);
      break;
    case "val":
      encodeValType(bt.type, enc);
      break;
    case "type":
      enc.i32(bt.typeIdx);
      break;
  }
}

export function encodeInstr(instr: Instr, enc: WasmEncoder): void {
  switch (instr.op) {
    case "unreachable":
      enc.byte(OP.unreachable);
      break;
    case "nop":
      enc.byte(OP.nop);
      break;
    case "block":
      enc.byte(OP.block);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.body) encodeInstr(i, enc);
      enc.byte(OP.end);
      break;
    case "loop":
      enc.byte(OP.loop);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.body) encodeInstr(i, enc);
      enc.byte(OP.end);
      break;
    case "if": {
      enc.byte(OP.if);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.then) encodeInstr(i, enc);
      const hasElse = instr.else && instr.else.length > 0;
      const needsElse = hasElse || instr.blockType.kind === "val";
      if (needsElse) {
        enc.byte(OP.else);
        if (hasElse) {
          for (const i of instr.else!) encodeInstr(i, enc);
        } else {
          // Valued if with no else — emit unreachable to satisfy validator
          enc.byte(OP.unreachable);
        }
      }
      enc.byte(OP.end);
      break;
    }
    case "br":
      enc.byte(OP.br);
      enc.u32(instr.depth);
      break;
    case "br_if":
      enc.byte(OP.br_if);
      enc.u32(instr.depth);
      break;
    case "return":
      enc.byte(OP.return);
      break;
    case "call":
      enc.byte(OP.call);
      enc.u32(instr.funcIdx);
      break;
    case "call_indirect":
      enc.byte(OP.call_indirect);
      enc.u32(instr.typeIdx);
      enc.u32(instr.tableIdx);
      break;
    case "drop":
      enc.byte(OP.drop);
      break;
    case "select":
      enc.byte(OP.select);
      break;
    case "local.get":
      enc.byte(OP.local_get);
      enc.u32(instr.index);
      break;
    case "local.set":
      enc.byte(OP.local_set);
      enc.u32(instr.index);
      break;
    case "local.tee":
      enc.byte(OP.local_tee);
      enc.u32(instr.index);
      break;
    case "global.get":
      enc.byte(OP.global_get);
      enc.u32(instr.index);
      break;
    case "global.set":
      enc.byte(OP.global_set);
      enc.u32(instr.index);
      break;
    case "i32.const":
      enc.byte(OP.i32_const);
      enc.i32(instr.value);
      break;
    case "i64.const":
      enc.byte(OP.i64_const);
      enc.i64(instr.value);
      break;
    case "i64.add":
      enc.byte(OP.i64_add);
      break;
    case "i64.sub":
      enc.byte(OP.i64_sub);
      break;
    case "i64.mul":
      enc.byte(OP.i64_mul);
      break;
    case "i64.div_s":
      enc.byte(OP.i64_div_s);
      break;
    case "i64.rem_s":
      enc.byte(OP.i64_rem_s);
      break;
    case "i64.eq":
      enc.byte(OP.i64_eq);
      break;
    case "i64.ne":
      enc.byte(OP.i64_ne);
      break;
    case "i64.lt_s":
      enc.byte(OP.i64_lt_s);
      break;
    case "i64.le_s":
      enc.byte(OP.i64_le_s);
      break;
    case "i64.gt_s":
      enc.byte(OP.i64_gt_s);
      break;
    case "i64.ge_s":
      enc.byte(OP.i64_ge_s);
      break;
    case "i64.eqz":
      enc.byte(OP.i64_eqz);
      break;
    case "i64.and":
      enc.byte(OP.i64_and);
      break;
    case "i64.or":
      enc.byte(OP.i64_or);
      break;
    case "i64.xor":
      enc.byte(OP.i64_xor);
      break;
    case "i64.shl":
      enc.byte(OP.i64_shl);
      break;
    case "i64.shr_s":
      enc.byte(OP.i64_shr_s);
      break;
    case "i64.shr_u":
      enc.byte(OP.i64_shr_u);
      break;
    case "i64.extend_i32_s":
      enc.byte(OP.i64_extend_i32_s);
      break;
    case "i64.extend_i32_u":
      enc.byte(OP.i64_extend_i32_u);
      break;
    case "i64.trunc_f64_s":
      enc.byte(OP.i64_trunc_f64_s);
      break;
    case "f64.convert_i64_s":
      enc.byte(OP.f64_convert_i64_s);
      break;
    case "f64.const":
      enc.byte(OP.f64_const);
      enc.f64(instr.value);
      break;
    case "f32.const":
      enc.byte(OP.f32_const);
      enc.f32(instr.value);
      break;
    case "i32.eqz":
      enc.byte(OP.i32_eqz);
      break;
    case "i32.eq":
      enc.byte(OP.i32_eq);
      break;
    case "i32.ne":
      enc.byte(OP.i32_ne);
      break;
    case "i32.lt_s":
      enc.byte(OP.i32_lt_s);
      break;
    case "i32.le_s":
      enc.byte(OP.i32_le_s);
      break;
    case "i32.gt_s":
      enc.byte(OP.i32_gt_s);
      break;
    case "i32.ge_s":
      enc.byte(OP.i32_ge_s);
      break;
    case "i32.ge_u":
      enc.byte(OP.i32_ge_u);
      break;
    case "i32.add":
      enc.byte(OP.i32_add);
      break;
    case "i32.sub":
      enc.byte(OP.i32_sub);
      break;
    case "i32.mul":
      enc.byte(OP.i32_mul);
      break;
    case "i32.and":
      enc.byte(OP.i32_and);
      break;
    case "i32.or":
      enc.byte(OP.i32_or);
      break;
    case "i32.xor":
      enc.byte(OP.i32_xor);
      break;
    case "i32.shl":
      enc.byte(OP.i32_shl);
      break;
    case "i32.shr_s":
      enc.byte(OP.i32_shr_s);
      break;
    case "i32.shr_u":
      enc.byte(OP.i32_shr_u);
      break;
    case "i32.clz":
      enc.byte(OP.i32_clz);
      break;
    case "i32.trunc_sat_f64_s":
      enc.byte(OP.misc_prefix);
      enc.byte(OP.i32_trunc_sat_f64_s);
      break;
    case "i32.trunc_sat_f64_u":
      enc.byte(OP.misc_prefix);
      enc.byte(OP.i32_trunc_sat_f64_u);
      break;
    case "f64.eq":
      enc.byte(OP.f64_eq);
      break;
    case "f64.ne":
      enc.byte(OP.f64_ne);
      break;
    case "f64.lt":
      enc.byte(OP.f64_lt);
      break;
    case "f64.le":
      enc.byte(OP.f64_le);
      break;
    case "f64.gt":
      enc.byte(OP.f64_gt);
      break;
    case "f64.ge":
      enc.byte(OP.f64_ge);
      break;
    case "f64.abs":
      enc.byte(OP.f64_abs);
      break;
    case "f64.neg":
      enc.byte(OP.f64_neg);
      break;
    case "f64.ceil":
      enc.byte(OP.f64_ceil);
      break;
    case "f64.floor":
      enc.byte(OP.f64_floor);
      break;
    case "f64.trunc":
      enc.byte(OP.f64_trunc);
      break;
    case "f64.nearest":
      enc.byte(OP.f64_nearest);
      break;
    case "f64.sqrt":
      enc.byte(OP.f64_sqrt);
      break;
    case "f64.add":
      enc.byte(OP.f64_add);
      break;
    case "f64.sub":
      enc.byte(OP.f64_sub);
      break;
    case "f64.mul":
      enc.byte(OP.f64_mul);
      break;
    case "f64.div":
      enc.byte(OP.f64_div);
      break;
    case "f64.min":
      enc.byte(OP.f64_min);
      break;
    case "f64.max":
      enc.byte(OP.f64_max);
      break;
    case "f64.copysign":
      enc.byte(OP.f64_copysign);
      break;
    case "i32.trunc_f64_s":
      enc.byte(OP.i32_trunc_f64_s);
      break;
    case "f64.convert_i32_s":
      enc.byte(OP.f64_convert_i32_s);
      break;
    case "f64.convert_i32_u":
      enc.byte(OP.f64_convert_i32_u);
      break;
    case "ref.null":
      enc.byte(OP.ref_null);
      enc.i32(instr.typeIdx);
      break;
    case "ref.null.extern":
      enc.byte(OP.ref_null);
      enc.byte(TYPE.externref);
      break;
    case "ref.null.eq":
      enc.byte(OP.ref_null);
      enc.byte(TYPE.eq);
      break;
    case "ref.is_null":
      enc.byte(OP.ref_is_null);
      break;
    case "ref.as_non_null":
      enc.byte(OP.ref_as_non_null);
      break;
    case "ref.eq":
      enc.byte(OP.ref_eq);
      break;
    case "ref.cast":
      enc.byte(GC.prefix);
      enc.byte(GC.ref_cast);
      enc.i32(instr.typeIdx);
      break;
    case "any.convert_extern":
      enc.byte(GC.prefix);
      enc.byte(GC.any_convert_extern);
      break;
    case "extern.convert_any":
      enc.byte(GC.prefix);
      enc.byte(GC.extern_convert_any);
      break;
    case "ref.test":
      enc.byte(GC.prefix);
      enc.byte(GC.ref_test);
      enc.i32(instr.typeIdx);
      break;
    case "struct.new":
      enc.byte(GC.prefix);
      enc.byte(GC.struct_new);
      enc.u32(instr.typeIdx);
      break;
    case "struct.get":
      enc.byte(GC.prefix);
      enc.byte(GC.struct_get);
      enc.u32(instr.typeIdx);
      enc.u32(instr.fieldIdx);
      break;
    case "struct.set":
      enc.byte(GC.prefix);
      enc.byte(GC.struct_set);
      enc.u32(instr.typeIdx);
      enc.u32(instr.fieldIdx);
      break;
    case "array.new":
      enc.byte(GC.prefix);
      enc.byte(GC.array_new);
      enc.u32(instr.typeIdx);
      break;
    case "array.new_fixed":
      enc.byte(GC.prefix);
      enc.byte(GC.array_new_fixed);
      enc.u32(instr.typeIdx);
      enc.u32(instr.length);
      break;
    case "array.new_default":
      enc.byte(GC.prefix);
      enc.byte(GC.array_new_default);
      enc.u32(instr.typeIdx);
      break;
    case "array.get":
      enc.byte(GC.prefix);
      enc.byte(GC.array_get);
      enc.u32(instr.typeIdx);
      break;
    case "array.get_s":
      enc.byte(GC.prefix);
      enc.byte(GC.array_get_s);
      enc.u32(instr.typeIdx);
      break;
    case "array.get_u":
      enc.byte(GC.prefix);
      enc.byte(GC.array_get_u);
      enc.u32(instr.typeIdx);
      break;
    case "array.set":
      enc.byte(GC.prefix);
      enc.byte(GC.array_set);
      enc.u32(instr.typeIdx);
      break;
    case "array.len":
      enc.byte(GC.prefix);
      enc.byte(GC.array_len);
      break;
    case "array.copy":
      enc.byte(GC.prefix);
      enc.byte(GC.array_copy);
      enc.u32(instr.dstTypeIdx);
      enc.u32(instr.srcTypeIdx);
      break;
    case "array.fill":
      enc.byte(GC.prefix);
      enc.byte(GC.array_fill);
      enc.u32(instr.typeIdx);
      break;
    case "ref.func":
      enc.byte(OP.ref_func);
      enc.u32(instr.funcIdx);
      break;
    case "call_ref":
      enc.byte(OP.call_ref);
      enc.u32(instr.typeIdx);
      break;
    case "memory.size":
      enc.byte(OP.memory_size);
      enc.byte(0x00);
      break;
    case "memory.grow":
      enc.byte(OP.memory_grow);
      enc.byte(0x00);
      break;
    case "throw":
      enc.byte(OP.throw);
      enc.u32(instr.tagIdx);
      break;
    case "rethrow":
      enc.byte(OP.rethrow);
      enc.u32(instr.depth);
      break;
    case "try": {
      enc.byte(OP.try);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.body) encodeInstr(i, enc);
      // Encode catch clauses (catch $tag)
      for (const c of instr.catches) {
        enc.byte(OP.catch);
        enc.u32(c.tagIdx);
        for (const i of c.body) encodeInstr(i, enc);
      }
      // Encode catch_all clause
      if (instr.catchAll) {
        enc.byte(OP.catch_all);
        for (const i of instr.catchAll) encodeInstr(i, enc);
      }
      enc.byte(OP.end);
      break;
    }
    // Memory load/store (linear memory)
    case "i32.load":
      enc.byte(OP.i32_load);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.load8_u":
      enc.byte(OP.i32_load8_u);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.load8_s":
      enc.byte(OP.i32_load8_s);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.load16_u":
      enc.byte(OP.i32_load16_u);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.store":
      enc.byte(OP.i32_store);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.store8":
      enc.byte(OP.i32_store8);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.store16":
      enc.byte(OP.i32_store16);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    // Integer division and remainder
    case "i32.div_s":
      enc.byte(OP.i32_div_s);
      break;
    case "i32.div_u":
      enc.byte(OP.i32_div_u);
      break;
    case "i32.rem_s":
      enc.byte(OP.i32_rem_s);
      break;
    case "i32.rem_u":
      enc.byte(OP.i32_rem_u);
      break;
    // Unsigned comparisons
    case "i32.lt_u":
      enc.byte(OP.i32_lt_u);
      break;
    case "i32.le_u":
      enc.byte(OP.i32_le_u);
      break;
    case "i32.gt_u":
      enc.byte(OP.i32_gt_u);
      break;
    // f64 memory load/store
    case "f64.load":
      enc.byte(OP.f64_load);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "f64.store":
      enc.byte(OP.f64_store);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    // f32 memory load/store and conversion
    case "f32.load":
      enc.byte(OP.f32_load);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "f32.store":
      enc.byte(OP.f32_store);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "f32.demote_f64":
      enc.byte(OP.f32_demote_f64);
      break;
    case "f64.promote_f32":
      enc.byte(OP.f64_promote_f32);
      break;

    // ---- SIMD v128 instructions ----
    case "v128.const":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_const);
      enc.v128(instr.bytes);
      break;
    case "v128.load":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.store":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_store);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.not":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_not);
      break;
    case "v128.and":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_and);
      break;
    case "v128.andnot":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_andnot);
      break;
    case "v128.or":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_or);
      break;
    case "v128.xor":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_xor);
      break;
    case "v128.bitselect":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_bitselect);
      break;
    case "v128.any_true":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_any_true);
      break;

    // i8x16
    case "i8x16.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_splat);
      break;
    case "i8x16.extract_lane_s":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_extract_lane_s);
      enc.byte(instr.lane);
      break;
    case "i8x16.extract_lane_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_extract_lane_u);
      enc.byte(instr.lane);
      break;
    case "i8x16.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_replace_lane);
      enc.byte(instr.lane);
      break;
    case "i8x16.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_eq);
      break;
    case "i8x16.ne":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_ne);
      break;
    case "i8x16.all_true":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_all_true);
      break;
    case "i8x16.bitmask":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_bitmask);
      break;
    case "i8x16.swizzle":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_swizzle);
      break;
    case "i8x16.shuffle":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_shuffle);
      for (const lane of instr.lanes) enc.byte(lane);
      break;
    case "i8x16.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_add);
      break;
    case "i8x16.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_sub);
      break;
    case "i8x16.min_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_min_u);
      break;
    case "i8x16.max_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_max_u);
      break;

    // i16x8
    case "i16x8.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_splat);
      break;
    case "i16x8.extract_lane_s":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_extract_lane_s);
      enc.byte(instr.lane);
      break;
    case "i16x8.extract_lane_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_extract_lane_u);
      enc.byte(instr.lane);
      break;
    case "i16x8.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_replace_lane);
      enc.byte(instr.lane);
      break;
    case "i16x8.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_eq);
      break;
    case "i16x8.ne":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_ne);
      break;
    case "i16x8.lt_s":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_lt_s);
      break;
    case "i16x8.gt_s":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_gt_s);
      break;
    case "i16x8.all_true":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_all_true);
      break;
    case "i16x8.bitmask":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_bitmask);
      break;
    case "i16x8.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_add);
      break;
    case "i16x8.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_sub);
      break;
    case "i16x8.mul":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_mul);
      break;
    case "i16x8.shl":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_shl);
      break;
    case "i16x8.shr_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_shr_u);
      break;

    // i32x4
    case "i32x4.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_splat);
      break;
    case "i32x4.extract_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_extract_lane);
      enc.byte(instr.lane);
      break;
    case "i32x4.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_replace_lane);
      enc.byte(instr.lane);
      break;
    case "i32x4.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_eq);
      break;
    case "i32x4.ne":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_ne);
      break;
    case "i32x4.all_true":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_all_true);
      break;
    case "i32x4.bitmask":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_bitmask);
      break;
    case "i32x4.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_add);
      break;
    case "i32x4.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_sub);
      break;
    case "i32x4.mul":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_mul);
      break;
    case "i32x4.shl":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_shl);
      break;
    case "i32x4.shr_s":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_shr_s);
      break;
    case "i32x4.shr_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_shr_u);
      break;

    // i64x2
    case "i64x2.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_splat);
      break;
    case "i64x2.extract_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_extract_lane);
      enc.byte(instr.lane);
      break;
    case "i64x2.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_replace_lane);
      enc.byte(instr.lane);
      break;
    case "i64x2.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_add);
      break;
    case "i64x2.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_sub);
      break;
    case "i64x2.mul":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_mul);
      break;
    case "i64x2.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_eq);
      break;
    case "i64x2.ne":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_ne);
      break;

    // f32x4
    case "f32x4.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_splat);
      break;
    case "f32x4.extract_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_extract_lane);
      enc.byte(instr.lane);
      break;
    case "f32x4.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_replace_lane);
      enc.byte(instr.lane);
      break;
    case "f32x4.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_eq);
      break;
    case "f32x4.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_add);
      break;
    case "f32x4.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_sub);
      break;
    case "f32x4.mul":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_mul);
      break;
    case "f32x4.div":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_div);
      break;

    // f64x2
    case "f64x2.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_splat);
      break;
    case "f64x2.extract_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_extract_lane);
      enc.byte(instr.lane);
      break;
    case "f64x2.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_replace_lane);
      enc.byte(instr.lane);
      break;
    case "f64x2.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_eq);
      break;
    case "f64x2.ne":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_ne);
      break;
    case "f64x2.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_add);
      break;
    case "f64x2.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_sub);
      break;
    case "f64x2.mul":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_mul);
      break;
    case "f64x2.div":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_div);
      break;

    // SIMD load splat variants
    case "v128.load8_splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load8_splat);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.load16_splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load16_splat);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.load32_splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load32_splat);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.load64_splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load64_splat);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.load32_zero":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load32_zero);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.load64_zero":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load64_zero);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
  }
}

/** Emit a sourceMappingURL custom section */
export function emitSourceMappingURLSection(enc: WasmEncoder, url: string): void {
  enc.section(SECTION.custom, (s) => {
    s.name("sourceMappingURL");
    s.name(url);
  });
}
