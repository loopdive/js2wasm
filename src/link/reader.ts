// Copyright (c) 2026 Loopdive GmbH. Licensed under AGPL-3.0.
/**
 * Relocatable Wasm object file (.o) parser.
 *
 * Parses LLVM-style wasm object files that include linking metadata
 * and relocation sections. Extracts all standard wasm sections plus
 * the "linking" custom section (symbol table) and "reloc.*" custom
 * sections.
 */

// ── Public types ──────────────────────────────────────────────────

export interface ParsedObject {
  name: string;
  types: TypeSection[];
  imports: ImportEntry[];
  functions: FunctionEntry[];
  tables: TableEntry[];
  memories: MemoryEntry[];
  globals: GlobalEntry[];
  exports: ExportEntry[];
  elements: ElementEntry[];
  tags: TagEntry[];
  code: CodeEntry[];
  symbols: SymbolInfo[];
  relocations: Map<string, RelocEntry[]>;
}

export interface TypeSection {
  params: number[];
  results: number[];
}

export interface ImportEntry {
  module: string;
  name: string;
  kind: number; // 0=func, 1=table, 2=memory, 3=global, 4=tag
  typeIdx?: number; // for func/tag imports
  globalType?: number; // for global imports
  globalMutable?: boolean;
  tableElementType?: number;
  tableMin?: number;
  tableMax?: number;
  memoryMin?: number;
  memoryMax?: number;
}

export interface FunctionEntry {
  typeIdx: number;
}

export interface TableEntry {
  elementType: number;
  min: number;
  max?: number;
}

export interface MemoryEntry {
  min: number;
  max?: number;
}

export interface GlobalEntry {
  type: number;
  mutable: boolean;
  init: Uint8Array;
}

export interface ExportEntry {
  name: string;
  kind: number; // 0=func, 1=table, 2=memory, 3=global
  index: number;
}

export interface ElementEntry {
  tableIdx: number;
  offsetExpr: Uint8Array;
  funcIndices: number[];
}

export interface TagEntry {
  attribute: number;
  typeIdx: number;
}

export interface CodeEntry {
  locals: { count: number; type: number }[];
  body: Uint8Array;
}

export interface SymbolInfo {
  kind: number; // 0=function, 1=data, 2=global, 3=section, 4=event/tag, 5=table
  name: string;
  index: number;
  flags: number;
}

export interface RelocEntry {
  type: number;
  offset: number;
  symbolIndex: number;
  addend?: number;
}

// ── Symbol flags ──────────────────────────────────────────────────

export const SYMBOL_BINDING_WEAK = 0x01;
export const SYMBOL_BINDING_LOCAL = 0x02;
export const SYMBOL_VISIBILITY_HIDDEN = 0x04;
export const SYMBOL_UNDEFINED = 0x10;
export const SYMBOL_EXPORTED = 0x20;
export const SYMBOL_EXPLICIT_NAME = 0x40;
export const SYMBOL_NO_STRIP = 0x80;

// ── Symbol kinds ──────────────────────────────────────────────────

export const SYMTAB_FUNCTION = 0;
export const SYMTAB_DATA = 1;
export const SYMTAB_GLOBAL = 2;
export const SYMTAB_SECTION = 3;
export const SYMTAB_EVENT = 4;
export const SYMTAB_TABLE = 5;

// ── Relocation types ──────────────────────────────────────────────

export const R_WASM_FUNCTION_INDEX_LEB = 0;
export const R_WASM_TABLE_INDEX_SLEB = 1;
export const R_WASM_TABLE_INDEX_I32 = 2;
export const R_WASM_MEMORY_ADDR_LEB = 3;
export const R_WASM_MEMORY_ADDR_SLEB = 4;
export const R_WASM_MEMORY_ADDR_I32 = 5;
export const R_WASM_TYPE_INDEX_LEB = 6;
export const R_WASM_GLOBAL_INDEX_LEB = 7;
export const R_WASM_FUNCTION_OFFSET_I32 = 8;
export const R_WASM_SECTION_OFFSET_I32 = 9;
export const R_WASM_TAG_INDEX_LEB = 10;
export const R_WASM_TABLE_INDEX_LEB = 15;
export const R_WASM_TABLE_NUMBER_LEB = 20;

// Reloc types that have an addend field
const RELOC_HAS_ADDEND = new Set([
  R_WASM_MEMORY_ADDR_LEB,
  R_WASM_MEMORY_ADDR_SLEB,
  R_WASM_MEMORY_ADDR_I32,
  R_WASM_FUNCTION_OFFSET_I32,
  R_WASM_SECTION_OFFSET_I32,
]);

// ── Linking subsection types ──────────────────────────────────────

const WASM_SEGMENT_INFO = 5;
const WASM_INIT_FUNCS = 6;
const WASM_COMDAT_INFO = 7;
const WASM_SYMBOL_TABLE = 8;

// ── Wasm section IDs ─────────────────────────────────────────────

const SECTION_CUSTOM = 0;
const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_FUNCTION = 3;
const SECTION_TABLE = 4;
const SECTION_MEMORY = 5;
const SECTION_GLOBAL = 6;
const SECTION_EXPORT = 7;
const SECTION_START = 8;
const SECTION_ELEMENT = 9;
const SECTION_CODE = 10;
const SECTION_DATA = 11;
const SECTION_TAG = 13;

// ── Reader helper ─────────────────────────────────────────────────

class ByteReader {
  public pos: number;
  public readonly data: Uint8Array;
  constructor(data: Uint8Array, offset = 0) {
    this.data = data;
    this.pos = offset;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  byte(): number {
    if (this.pos >= this.data.length) {
      throw new Error(`Unexpected end of data at offset ${this.pos}`);
    }
    return this.data[this.pos++]!;
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.data.length) {
      throw new Error(`Unexpected end of data: need ${n} bytes at offset ${this.pos}`);
    }
    const slice = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  /** Read unsigned LEB128 */
  u32(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.byte();
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return result >>> 0;
  }

  /** Read signed LEB128 (32-bit) */
  i32(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.byte();
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    if (shift < 32 && (b & 0x40) !== 0) {
      result |= -(1 << shift);
    }
    return result;
  }

  /** Read UTF-8 name (length-prefixed) */
  name(): string {
    const len = this.u32();
    const bytes = this.bytes(len);
    return new TextDecoder().decode(bytes);
  }
}

// ── Main parser ───────────────────────────────────────────────────

export function parseObject(name: string, bytes: Uint8Array): ParsedObject {
  const r = new ByteReader(bytes);

  // Verify magic number
  const magic = r.bytes(4);
  if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
    throw new Error(`Invalid wasm magic in "${name}"`);
  }

  // Verify version
  const version = r.bytes(4);
  if (version[0] !== 0x01 || version[1] !== 0x00 || version[2] !== 0x00 || version[3] !== 0x00) {
    throw new Error(`Unsupported wasm version in "${name}"`);
  }

  const result: ParsedObject = {
    name,
    types: [],
    imports: [],
    functions: [],
    tables: [],
    memories: [],
    globals: [],
    exports: [],
    elements: [],
    tags: [],
    code: [],
    symbols: [],
    relocations: new Map(),
  };

  while (r.remaining > 0) {
    const sectionId = r.byte();
    const sectionSize = r.u32();
    const sectionEnd = r.pos + sectionSize;

    switch (sectionId) {
      case SECTION_CUSTOM:
        parseCustomSection(r, sectionEnd, result);
        break;
      case SECTION_TYPE:
        parseTypeSection(r, sectionEnd, result);
        break;
      case SECTION_IMPORT:
        parseImportSection(r, sectionEnd, result);
        break;
      case SECTION_FUNCTION:
        parseFunctionSection(r, sectionEnd, result);
        break;
      case SECTION_TABLE:
        parseTableSection(r, sectionEnd, result);
        break;
      case SECTION_MEMORY:
        parseMemorySection(r, sectionEnd, result);
        break;
      case SECTION_GLOBAL:
        parseGlobalSection(r, sectionEnd, result);
        break;
      case SECTION_EXPORT:
        parseExportSection(r, sectionEnd, result);
        break;
      case SECTION_START:
        // Skip start section
        r.pos = sectionEnd;
        break;
      case SECTION_ELEMENT:
        parseElementSection(r, sectionEnd, result);
        break;
      case SECTION_CODE:
        parseCodeSection(r, sectionEnd, result);
        break;
      case SECTION_DATA:
        // Skip data section (not needed for our linking)
        r.pos = sectionEnd;
        break;
      case SECTION_TAG:
        parseTagSection(r, sectionEnd, result);
        break;
      default:
        // Skip unknown sections
        r.pos = sectionEnd;
        break;
    }

    // Ensure we consumed exactly the section bytes
    if (r.pos !== sectionEnd) {
      r.pos = sectionEnd;
    }
  }

  return result;
}

// ── Section parsers ───────────────────────────────────────────────

function parseCustomSection(r: ByteReader, end: number, obj: ParsedObject): void {
  const nameStart = r.pos;
  const sectionName = r.name();

  if (sectionName === "linking") {
    parseLinkingSection(r, end, obj);
  } else if (sectionName.startsWith("reloc.")) {
    parseRelocSection(r, end, sectionName, obj);
  } else {
    // Skip unknown custom sections
    r.pos = end;
  }
}

function parseTypeSection(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const form = r.byte(); // 0x60 = func type
    if (form !== 0x60) {
      throw new Error(`Unsupported type form 0x${form.toString(16)}`);
    }
    const paramCount = r.u32();
    const params: number[] = [];
    for (let j = 0; j < paramCount; j++) {
      params.push(r.byte());
    }
    const resultCount = r.u32();
    const results: number[] = [];
    for (let j = 0; j < resultCount; j++) {
      results.push(r.byte());
    }
    obj.types.push({ params, results });
  }
}

function parseImportSection(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const module = r.name();
    const name = r.name();
    const kind = r.byte();
    const entry: ImportEntry = { module, name, kind };

    switch (kind) {
      case 0: // func
        entry.typeIdx = r.u32();
        break;
      case 1: // table
        entry.tableElementType = r.byte();
        {
          const hasMax = r.byte();
          entry.tableMin = r.u32();
          if (hasMax) {
            entry.tableMax = r.u32();
          }
        }
        break;
      case 2: // memory
        {
          const hasMax = r.byte();
          entry.memoryMin = r.u32();
          if (hasMax) {
            entry.memoryMax = r.u32();
          }
        }
        break;
      case 3: // global
        entry.globalType = r.byte();
        entry.globalMutable = r.byte() !== 0;
        break;
      case 4: // tag
        r.byte(); // attribute (0 = exception)
        entry.typeIdx = r.u32();
        break;
      default:
        throw new Error(`Unknown import kind: ${kind}`);
    }

    obj.imports.push(entry);
  }
}

function parseFunctionSection(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    obj.functions.push({ typeIdx: r.u32() });
  }
}

function parseTableSection(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const elementType = r.byte();
    const hasMax = r.byte();
    const min = r.u32();
    const max = hasMax ? r.u32() : undefined;
    obj.tables.push({ elementType, min, max });
  }
}

function parseMemorySection(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const hasMax = r.byte();
    const min = r.u32();
    const max = hasMax ? r.u32() : undefined;
    obj.memories.push({ min, max });
  }
}

function parseGlobalSection(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const type = r.byte();
    const mutable = r.byte() !== 0;
    // Read init expr until 0x0b (end)
    const initStart = r.pos;
    while (r.byte() !== 0x0b) {
      // scan for end opcode
    }
    const init = r.data.slice(initStart, r.pos);
    obj.globals.push({ type, mutable, init });
  }
}

function parseExportSection(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const name = r.name();
    const kind = r.byte();
    const index = r.u32();
    obj.exports.push({ name, kind, index });
  }
}

function parseElementSection(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const flags = r.u32();
    // Simple case: active element with table 0, funcref
    let tableIdx = 0;
    if (flags & 0x02) {
      tableIdx = r.u32();
    }
    // Read offset expression
    const offsetStart = r.pos;
    while (r.byte() !== 0x0b) {
      // scan for end
    }
    const offsetExpr = r.data.slice(offsetStart, r.pos);

    if (flags & 0x03) {
      // Element kind or type
      if (flags & 0x01) {
        r.byte(); // element kind or ref type
      }
    }

    const elemCount = r.u32();
    const funcIndices: number[] = [];
    for (let j = 0; j < elemCount; j++) {
      funcIndices.push(r.u32());
    }
    obj.elements.push({ tableIdx, offsetExpr, funcIndices });
  }
}

function parseCodeSection(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const bodySize = r.u32();
    const bodyEnd = r.pos + bodySize;

    // Parse locals
    const localDeclCount = r.u32();
    const locals: { count: number; type: number }[] = [];
    for (let j = 0; j < localDeclCount; j++) {
      const lcount = r.u32();
      const ltype = r.byte();
      locals.push({ count: lcount, type: ltype });
    }

    // The rest is the code body (up to bodyEnd)
    const body = r.data.slice(r.pos, bodyEnd);
    r.pos = bodyEnd;

    obj.code.push({ locals, body });
  }
}

function parseTagSection(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const attribute = r.byte();
    const typeIdx = r.u32();
    obj.tags.push({ attribute, typeIdx });
  }
}

// ── Linking section parser ────────────────────────────────────────

function parseLinkingSection(r: ByteReader, end: number, obj: ParsedObject): void {
  const version = r.u32();
  if (version !== 2) {
    throw new Error(`Unsupported linking section version: ${version}`);
  }

  while (r.pos < end) {
    const subsectionType = r.byte();
    const subsectionSize = r.u32();
    const subsectionEnd = r.pos + subsectionSize;

    if (subsectionType === WASM_SYMBOL_TABLE) {
      parseSymbolTable(r, subsectionEnd, obj);
    } else {
      // Skip other subsections (segment info, init funcs, comdat info)
      r.pos = subsectionEnd;
    }
  }
}

function parseSymbolTable(r: ByteReader, _end: number, obj: ParsedObject): void {
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const kind = r.byte();
    const flags = r.u32();

    let name = "";
    let index = 0;

    switch (kind) {
      case SYMTAB_FUNCTION:
      case SYMTAB_GLOBAL:
      case SYMTAB_EVENT:
      case SYMTAB_TABLE: {
        index = r.u32();
        if (!(flags & SYMBOL_UNDEFINED) || flags & SYMBOL_EXPLICIT_NAME) {
          name = r.name();
        }
        break;
      }
      case SYMTAB_DATA: {
        name = r.name();
        if (!(flags & SYMBOL_UNDEFINED)) {
          index = r.u32(); // segment index
          r.u32(); // offset
          r.u32(); // size
        }
        break;
      }
      case SYMTAB_SECTION: {
        index = r.u32(); // section index
        break;
      }
      default:
        throw new Error(`Unknown symbol kind: ${kind}`);
    }

    obj.symbols.push({ kind, name, index, flags });
  }
}

// ── Relocation section parser ─────────────────────────────────────

function parseRelocSection(r: ByteReader, end: number, sectionName: string, obj: ParsedObject): void {
  const targetSection = r.u32(); // section index this reloc applies to
  const count = r.u32();
  const entries: RelocEntry[] = [];

  for (let i = 0; i < count; i++) {
    const type = r.byte();
    const offset = r.u32();
    const symbolIndex = r.u32();
    let addend: number | undefined;
    if (RELOC_HAS_ADDEND.has(type)) {
      addend = r.i32();
    }
    entries.push({ type, offset, symbolIndex, addend });
  }

  obj.relocations.set(sectionName, entries);
}
