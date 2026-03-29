/**
 * Relocatable Wasm object file (.o) emitter.
 *
 * Produces a Wasm binary augmented with LLVM-style linking metadata:
 *   - "linking" custom section (version 2, symbol table)
 *   - "reloc.CODE" custom section (relocation entries for the code section)
 *
 * The output follows the LLVM Wasm object file format so that a future
 * linker can combine multiple .o files into a single executable Wasm module.
 */

import type {
  WasmModule,
  WasmFunction,
  Instr,
  Import,
} from "../ir/types.js";
import { WasmEncoder } from "./encoder.js";
import {
  OP,
  GC,
  TYPE,
  SECTION,
  RELOC,
  SYM_FLAGS,
  SYMTAB,
  LINKING_SUBSECTION,
} from "./opcodes.js";
import {
  encodeTypeDef,
  encodeImport,
  encodeGlobal,
  encodeExport,
  encodeValType,
  encodeBlockType,
  groupLocals,
} from "./binary.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RelocEntry {
  type: number;        // RELOC.R_WASM_*
  offset: number;      // byte offset within the section
  symbolIndex: number;  // index into linking symbol table
}

export interface SymbolInfo {
  kind: number;   // SYMTAB.*
  name: string;
  index: number;  // function/global/tag index in the wasm index space
  flags: number;  // SYM_FLAGS bitmask
}

// ── emitObject ───────────────────────────────────────────────────────

/** Emit a relocatable Wasm object file (.o) from an IR module */
export function emitObject(mod: WasmModule): Uint8Array {
  // Pre-compute import counts
  const numImportFuncs = mod.imports.filter((i) => i.desc.kind === "func").length;
  const numImportGlobals = mod.imports.filter((i) => i.desc.kind === "global").length;
  const numImportTags = mod.imports.filter((i) => i.desc.kind === "tag").length;

  // Build the set of exported function indices for quick lookup
  const exportedFuncIndices = new Set<number>();
  for (const exp of mod.exports) {
    if (exp.desc.kind === "func") {
      exportedFuncIndices.add(exp.desc.index);
    }
  }

  // Build the set of exported global indices
  const exportedGlobalIndices = new Set<number>();
  for (const exp of mod.exports) {
    if (exp.desc.kind === "global") {
      exportedGlobalIndices.add(exp.desc.index);
    }
  }

  // ── Build symbol table ────────────────────────────────────────────
  const symbols: SymbolInfo[] = [];

  // Map from function index -> symbol index (for relocation lookups)
  const funcIdxToSymIdx = new Map<number, number>();
  // Map from global index -> symbol index
  const globalIdxToSymIdx = new Map<number, number>();
  // Map from tag index -> symbol index
  const tagIdxToSymIdx = new Map<number, number>();
  // Map from type index -> symbol index (we use a convention to track type relocs)
  // For type relocations we don't have a separate symbol kind, so we track the raw index.
  // In the LLVM format, R_WASM_TYPE_INDEX_LEB uses the type index directly (not a symbol index).
  // We store type relocs with the type index in the symbolIndex field directly.

  // Imported functions
  let funcIdx = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func") {
      const symIdx = symbols.length;
      symbols.push({
        kind: SYMTAB.SYMTAB_FUNCTION,
        name: imp.name,
        index: funcIdx,
        flags: SYM_FLAGS.WASM_SYM_UNDEFINED,
      });
      funcIdxToSymIdx.set(funcIdx, symIdx);
      funcIdx++;
    }
  }

  // Defined functions
  for (const f of mod.functions) {
    const symIdx = symbols.length;
    const isExported = exportedFuncIndices.has(funcIdx);
    symbols.push({
      kind: SYMTAB.SYMTAB_FUNCTION,
      name: f.name || `__func_${funcIdx}`,
      index: funcIdx,
      flags: isExported ? SYM_FLAGS.WASM_SYM_EXPORTED : SYM_FLAGS.WASM_SYM_BINDING_LOCAL,
    });
    funcIdxToSymIdx.set(funcIdx, symIdx);
    funcIdx++;
  }

  // Imported globals
  let globalIdx = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "global") {
      const symIdx = symbols.length;
      symbols.push({
        kind: SYMTAB.SYMTAB_GLOBAL,
        name: imp.name,
        index: globalIdx,
        flags: SYM_FLAGS.WASM_SYM_UNDEFINED,
      });
      globalIdxToSymIdx.set(globalIdx, symIdx);
      globalIdx++;
    }
  }

  // Defined globals
  for (const g of mod.globals) {
    const symIdx = symbols.length;
    const isExported = exportedGlobalIndices.has(globalIdx);
    symbols.push({
      kind: SYMTAB.SYMTAB_GLOBAL,
      name: g.name || `__global_${globalIdx}`,
      index: globalIdx,
      flags: isExported ? SYM_FLAGS.WASM_SYM_EXPORTED : SYM_FLAGS.WASM_SYM_BINDING_LOCAL,
    });
    globalIdxToSymIdx.set(globalIdx, symIdx);
    globalIdx++;
  }

  // Imported tags
  let tagIdx = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "tag") {
      const symIdx = symbols.length;
      symbols.push({
        kind: SYMTAB.SYMTAB_EVENT,
        name: imp.name,
        index: tagIdx,
        flags: SYM_FLAGS.WASM_SYM_UNDEFINED,
      });
      tagIdxToSymIdx.set(tagIdx, symIdx);
      tagIdx++;
    }
  }

  // Defined tags
  for (const tag of mod.tags) {
    const symIdx = symbols.length;
    symbols.push({
      kind: SYMTAB.SYMTAB_EVENT,
      name: tag.name || `__tag_${tagIdx}`,
      index: tagIdx,
      flags: SYM_FLAGS.WASM_SYM_BINDING_LOCAL,
    });
    tagIdxToSymIdx.set(tagIdx, symIdx);
    tagIdx++;
  }

  // ── Emit standard wasm sections ───────────────────────────────────
  const enc = new WasmEncoder();

  // Magic + Version
  enc.bytes([0x00, 0x61, 0x73, 0x6d]); // \0asm
  enc.bytes([0x01, 0x00, 0x00, 0x00]); // version 1

  // Track which section index corresponds to the code section
  let sectionCount = 0;
  let codeSectionIndex = -1;

  // Type section
  if (mod.types.length > 0) {
    enc.section(SECTION.type, (s) => {
      s.vector(mod.types, (t, e) => encodeTypeDef(t, e));
    });
    sectionCount++;
  }

  // Import section
  if (mod.imports.length > 0) {
    enc.section(SECTION.import, (s) => {
      s.vector(mod.imports, (imp, e) => encodeImport(imp, e));
    });
    sectionCount++;
  }

  // Function section
  if (mod.functions.length > 0) {
    enc.section(SECTION.function, (s) => {
      s.vector(mod.functions, (f, e) => e.u32(f.typeIdx));
    });
    sectionCount++;
  }

  // Table section
  if (mod.tables.length > 0) {
    enc.section(SECTION.table, (s) => {
      s.vector(mod.tables, (t, e) => {
        e.byte(t.elementType === "funcref" ? TYPE.funcref : TYPE.externref);
        if (t.max !== undefined) {
          e.byte(0x01);
          e.u32(t.min);
          e.u32(t.max);
        } else {
          e.byte(0x00);
          e.u32(t.min);
        }
      });
    });
    sectionCount++;
  }

  // Tag section
  if (mod.tags.length > 0) {
    enc.section(SECTION.tag, (s) => {
      s.vector(mod.tags, (tag, e) => {
        e.byte(0x00);
        e.u32(tag.typeIdx);
      });
    });
    sectionCount++;
  }

  // Global section
  if (mod.globals.length > 0) {
    enc.section(SECTION.global, (s) => {
      s.vector(mod.globals, (g, e) => encodeGlobal(g, e));
    });
    sectionCount++;
  }

  // Export section
  if (mod.exports.length > 0) {
    enc.section(SECTION.export, (s) => {
      s.vector(mod.exports, (exp, e) => encodeExport(exp, e, numImportFuncs));
    });
    sectionCount++;
  }

  // Element section
  if (mod.elements.length > 0) {
    enc.section(SECTION.element, (s) => {
      s.vector(mod.elements, (elem, e) => {
        e.byte(0x00);
        for (const instr of elem.offset) encodeInstrWithReloc(instr, e, [], 0, funcIdxToSymIdx, globalIdxToSymIdx, tagIdxToSymIdx);
        e.byte(OP.end);
        e.vector(elem.funcIndices, (idx, enc2) => enc2.u32(idx));
      });
    });
    sectionCount++;
  }

  // ── Code section with relocation tracking ─────────────────────────
  const relocs: RelocEntry[] = [];

  if (mod.functions.length > 0) {
    codeSectionIndex = sectionCount;

    // Encode the code section content into a sub-encoder so we can
    // track byte offsets relative to the section payload start.
    const codeSec = new WasmEncoder();
    codeSec.u32(mod.functions.length); // vector count

    for (const f of mod.functions) {
      encodeFunctionWithReloc(
        f,
        codeSec,
        relocs,
        funcIdxToSymIdx,
        globalIdxToSymIdx,
        tagIdxToSymIdx,
      );
    }

    const codeBytes = codeSec.finish();
    enc.byte(SECTION.code);
    enc.u32(codeBytes.length);
    enc.bytes(codeBytes);
    sectionCount++;
  }

  // ── reloc.CODE custom section ─────────────────────────────────────
  if (relocs.length > 0 && codeSectionIndex >= 0) {
    enc.section(SECTION.custom, (s) => {
      s.name("reloc.CODE");
      s.u32(codeSectionIndex);
      s.u32(relocs.length);
      for (const r of relocs) {
        s.byte(r.type);
        s.u32(r.offset);
        s.u32(r.symbolIndex);
      }
    });
  }

  // ── linking custom section ────────────────────────────────────────
  enc.section(SECTION.custom, (s) => {
    s.name("linking");
    s.u32(2); // linking metadata version

    // WASM_SYMBOL_TABLE subsection
    const symSub = new WasmEncoder();
    symSub.u32(symbols.length);
    for (const sym of symbols) {
      symSub.byte(sym.kind);
      symSub.u32(sym.flags);
      symSub.u32(sym.index);
      // Name: written for defined symbols (not UNDEFINED)
      if (!(sym.flags & SYM_FLAGS.WASM_SYM_UNDEFINED)) {
        symSub.name(sym.name);
      }
    }
    const symData = symSub.finish();

    s.byte(LINKING_SUBSECTION.WASM_SYMBOL_TABLE);
    s.u32(symData.length);
    s.bytes(symData);
  });

  return enc.finish();
}

// ── Instruction encoding with relocation tracking ───────────────────

function encodeFunctionWithReloc(
  f: WasmFunction,
  enc: WasmEncoder,
  relocs: RelocEntry[],
  funcIdxToSymIdx: Map<number, number>,
  globalIdxToSymIdx: Map<number, number>,
  tagIdxToSymIdx: Map<number, number>,
): void {
  const body = new WasmEncoder();

  // Locals
  const localGroups = groupLocals(f.locals);
  body.vector(localGroups, (group, e) => {
    e.u32(group.count);
    encodeValType(group.type, e);
  });

  // The offset for relocations is measured from the start of the
  // code section payload (after the section id + size).
  // We record the position within the section-level encoder (`enc`)
  // *before* we write this function's body bytes, then add the
  // position within `body` where each relocatable operand starts.
  //
  // However, the section-level encoder includes the vector count and
  // the previous functions' size-prefixed bytes. The body encoder
  // starts fresh for each function. After encoding the body we know
  // its length and write: u32(bodyLen) + bodyBytes into `enc`.
  // So we need to compute: enc.position (before writing size+body)
  //   + LEB128_size(bodyLen) + instrOffsetInBody.

  // Encode body instructions, collecting relocs relative to body start
  const bodyRelocs: RelocEntry[] = [];
  for (const instr of f.body) {
    encodeInstrWithReloc(
      instr,
      body,
      bodyRelocs,
      0, // base offset within body
      funcIdxToSymIdx,
      globalIdxToSymIdx,
      tagIdxToSymIdx,
    );
  }
  body.byte(OP.end);

  const bodyBytes = body.finish();

  // Compute the size of the LEB128-encoded body length
  const sizePrefix = new WasmEncoder();
  sizePrefix.u32(bodyBytes.length);
  const sizePrefixLen = sizePrefix.finish().length;

  // The base offset within the code section payload for this function
  const funcBaseOffset = enc.position;

  // Adjust relocation offsets: each bodyReloc.offset is relative to
  // the start of `body`. The actual offset in the section payload is:
  //   funcBaseOffset + sizePrefixLen + bodyReloc.offset
  for (const r of bodyRelocs) {
    relocs.push({
      type: r.type,
      offset: funcBaseOffset + sizePrefixLen + r.offset,
      symbolIndex: r.symbolIndex,
    });
  }

  // Write size-prefixed body into the section encoder
  enc.u32(bodyBytes.length);
  enc.bytes(bodyBytes);
}

function encodeInstrWithReloc(
  instr: Instr,
  enc: WasmEncoder,
  relocs: RelocEntry[],
  _baseOffset: number,
  funcIdxToSymIdx: Map<number, number>,
  globalIdxToSymIdx: Map<number, number>,
  tagIdxToSymIdx: Map<number, number>,
): void {
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
      for (const i of instr.body)
        encodeInstrWithReloc(i, enc, relocs, 0, funcIdxToSymIdx, globalIdxToSymIdx, tagIdxToSymIdx);
      enc.byte(OP.end);
      break;
    case "loop":
      enc.byte(OP.loop);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.body)
        encodeInstrWithReloc(i, enc, relocs, 0, funcIdxToSymIdx, globalIdxToSymIdx, tagIdxToSymIdx);
      enc.byte(OP.end);
      break;
    case "if": {
      enc.byte(OP.if);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.then)
        encodeInstrWithReloc(i, enc, relocs, 0, funcIdxToSymIdx, globalIdxToSymIdx, tagIdxToSymIdx);
      const hasElse = instr.else && instr.else.length > 0;
      const needsElse = hasElse || instr.blockType.kind === "val";
      if (needsElse) {
        enc.byte(OP.else);
        if (hasElse) {
          for (const i of instr.else!)
            encodeInstrWithReloc(i, enc, relocs, 0, funcIdxToSymIdx, globalIdxToSymIdx, tagIdxToSymIdx);
        } else {
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
    case "call": {
      enc.byte(OP.call);
      const symIdx = funcIdxToSymIdx.get(instr.funcIdx);
      if (symIdx !== undefined) {
        relocs.push({
          type: RELOC.R_WASM_FUNCTION_INDEX_LEB,
          offset: enc.position,
          symbolIndex: symIdx,
        });
      }
      enc.u32(instr.funcIdx);
      break;
    }
    case "call_indirect": {
      enc.byte(OP.call_indirect);
      // Type index relocation
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      enc.u32(instr.tableIdx);
      break;
    }
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
    case "global.get": {
      enc.byte(OP.global_get);
      const symIdx = globalIdxToSymIdx.get(instr.index);
      if (symIdx !== undefined) {
        relocs.push({
          type: RELOC.R_WASM_GLOBAL_INDEX_LEB,
          offset: enc.position,
          symbolIndex: symIdx,
        });
      }
      enc.u32(instr.index);
      break;
    }
    case "global.set": {
      enc.byte(OP.global_set);
      const symIdx = globalIdxToSymIdx.get(instr.index);
      if (symIdx !== undefined) {
        relocs.push({
          type: RELOC.R_WASM_GLOBAL_INDEX_LEB,
          offset: enc.position,
          symbolIndex: symIdx,
        });
      }
      enc.u32(instr.index);
      break;
    }
    case "i32.const":
      enc.byte(OP.i32_const);
      enc.i32(instr.value);
      break;
    case "i64.const":
      enc.byte(OP.i64_const);
      enc.i64(instr.value);
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
    case "i64.trunc_sat_f64_s":
      enc.byte(OP.misc_prefix);
      enc.byte(OP.i64_trunc_sat_f64_s);
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
    case "i64.reinterpret_f64":
      enc.byte(OP.i64_reinterpret_f64);
      break;
    case "f64.reinterpret_i64":
      enc.byte(OP.f64_reinterpret_i64);
      break;
    case "ref.null":
      enc.byte(OP.ref_null);
      enc.i32(instr.typeIdx);
      break;
    case "ref.null.extern":
      enc.byte(OP.ref_null);
      enc.byte(TYPE.externref);
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
    case "ref.cast": {
      enc.byte(GC.prefix);
      enc.byte(GC.ref_cast);
      // Type index relocation
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.i32(instr.typeIdx);
      break;
    }
    case "ref.cast_null": {
      enc.byte(GC.prefix);
      enc.byte(GC.ref_cast_null);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.i32(instr.typeIdx);
      break;
    }
    case "any.convert_extern":
      enc.byte(GC.prefix);
      enc.byte(GC.any_convert_extern);
      break;
    case "extern.convert_any":
      enc.byte(GC.prefix);
      enc.byte(GC.extern_convert_any);
      break;
    case "ref.test": {
      enc.byte(GC.prefix);
      enc.byte(GC.ref_test);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.i32(instr.typeIdx);
      break;
    }
    case "struct.new": {
      enc.byte(GC.prefix);
      enc.byte(GC.struct_new);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      break;
    }
    case "struct.get": {
      enc.byte(GC.prefix);
      enc.byte(GC.struct_get);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      enc.u32(instr.fieldIdx);
      break;
    }
    case "struct.set": {
      enc.byte(GC.prefix);
      enc.byte(GC.struct_set);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      enc.u32(instr.fieldIdx);
      break;
    }
    case "array.new": {
      enc.byte(GC.prefix);
      enc.byte(GC.array_new);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      break;
    }
    case "array.new_fixed": {
      enc.byte(GC.prefix);
      enc.byte(GC.array_new_fixed);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      enc.u32(instr.length);
      break;
    }
    case "array.new_default": {
      enc.byte(GC.prefix);
      enc.byte(GC.array_new_default);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      break;
    }
    case "array.get": {
      enc.byte(GC.prefix);
      enc.byte(GC.array_get);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      break;
    }
    case "array.get_s": {
      enc.byte(GC.prefix);
      enc.byte(GC.array_get_s);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      break;
    }
    case "array.set": {
      enc.byte(GC.prefix);
      enc.byte(GC.array_set);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      break;
    }
    case "array.len":
      enc.byte(GC.prefix);
      enc.byte(GC.array_len);
      break;
    case "ref.func": {
      enc.byte(OP.ref_func);
      const symIdx = funcIdxToSymIdx.get(instr.funcIdx);
      if (symIdx !== undefined) {
        relocs.push({
          type: RELOC.R_WASM_FUNCTION_INDEX_LEB,
          offset: enc.position,
          symbolIndex: symIdx,
        });
      }
      enc.u32(instr.funcIdx);
      break;
    }
    case "call_ref": {
      enc.byte(OP.call_ref);
      relocs.push({
        type: RELOC.R_WASM_TYPE_INDEX_LEB,
        offset: enc.position,
        symbolIndex: instr.typeIdx,
      });
      enc.u32(instr.typeIdx);
      break;
    }
    case "memory.size":
      enc.byte(OP.memory_size);
      enc.byte(0x00);
      break;
    case "memory.grow":
      enc.byte(OP.memory_grow);
      enc.byte(0x00);
      break;
    case "throw": {
      enc.byte(OP.throw);
      const symIdx = tagIdxToSymIdx.get(instr.tagIdx);
      if (symIdx !== undefined) {
        relocs.push({
          type: RELOC.R_WASM_TAG_INDEX_LEB,
          offset: enc.position,
          symbolIndex: symIdx,
        });
      }
      enc.u32(instr.tagIdx);
      break;
    }
    case "rethrow":
      enc.byte(OP.rethrow);
      enc.u32(instr.depth);
      break;
    case "try": {
      enc.byte(OP.try);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.body)
        encodeInstrWithReloc(i, enc, relocs, 0, funcIdxToSymIdx, globalIdxToSymIdx, tagIdxToSymIdx);
      for (const c of instr.catches) {
        enc.byte(OP.catch);
        enc.u32(c.tagIdx);
        for (const i of c.body)
          encodeInstrWithReloc(i, enc, relocs, 0, funcIdxToSymIdx, globalIdxToSymIdx, tagIdxToSymIdx);
      }
      if (instr.catchAll) {
        enc.byte(OP.catch_all);
        for (const i of instr.catchAll)
          encodeInstrWithReloc(i, enc, relocs, 0, funcIdxToSymIdx, globalIdxToSymIdx, tagIdxToSymIdx);
      }
      enc.byte(OP.end);
      break;
    }
  }
}
