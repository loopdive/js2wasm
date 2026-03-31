/**
 * Test helper for building minimal valid .o wasm files with linking
 * metadata and relocation sections.
 *
 * Produces relocatable wasm object files compatible with the LLVM
 * wasm object file format (linking section version 2).
 */

// ── Helper encoder ────────────────────────────────────────────────

class Encoder {
  private buf: number[] = [];

  byte(b: number): void {
    this.buf.push(b & 0xff);
  }

  bytes(data: number[] | Uint8Array): void {
    for (const b of data) this.byte(b);
  }

  u32(value: number): void {
    do {
      let b = value & 0x7f;
      value >>>= 7;
      if (value !== 0) b |= 0x80;
      this.byte(b);
    } while (value !== 0);
  }

  i32(value: number): void {
    let more = true;
    while (more) {
      let b = value & 0x7f;
      value >>= 7;
      if ((value === 0 && (b & 0x40) === 0) || (value === -1 && (b & 0x40) !== 0)) {
        more = false;
      } else {
        b |= 0x80;
      }
      this.byte(b);
    }
  }

  name(s: string): void {
    const encoded = new TextEncoder().encode(s);
    this.u32(encoded.length);
    this.bytes(encoded);
  }

  /** Write section: id + length-prefixed payload */
  section(id: number, content: Uint8Array): void {
    this.byte(id);
    this.u32(content.length);
    this.bytes(content);
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buf);
  }

  get length(): number {
    return this.buf.length;
  }
}

// ── Symbol flags ──────────────────────────────────────────────────

export const SYMBOL_BINDING_WEAK = 0x01;
export const SYMBOL_BINDING_LOCAL = 0x02;
export const SYMBOL_VISIBILITY_HIDDEN = 0x04;
export const SYMBOL_UNDEFINED = 0x10;
export const SYMBOL_EXPORTED = 0x20;
export const SYMBOL_EXPLICIT_NAME = 0x40;

// ── Symbol kinds ──────────────────────────────────────────────────

export const SYMTAB_FUNCTION = 0;
export const SYMTAB_DATA = 1;
export const SYMTAB_GLOBAL = 2;
export const SYMTAB_SECTION = 3;
export const SYMTAB_EVENT = 4;
export const SYMTAB_TABLE = 5;

// ── Reloc types ───────────────────────────────────────────────────

export const R_WASM_FUNCTION_INDEX_LEB = 0;
export const R_WASM_GLOBAL_INDEX_LEB = 7;
export const R_WASM_TYPE_INDEX_LEB = 6;

// ── Section IDs ───────────────────────────────────────────────────

const SECTION_CUSTOM = 0;
const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_FUNCTION = 3;
const SECTION_TABLE = 4;
const SECTION_MEMORY = 5;
const SECTION_GLOBAL = 6;
const SECTION_EXPORT = 7;
const SECTION_ELEMENT = 9;
const SECTION_CODE = 10;
const SECTION_TAG = 13;

// ── WASM_SYMBOL_TABLE subsection type ─────────────────────────────

const WASM_SYMBOL_TABLE = 8;

// ── Configuration types ───────────────────────────────────────────

export interface TestFuncConfig {
  typeIdx: number;
  exported?: boolean;
  name: string;
  /** Raw body bytes (without locals preamble or end byte).
   *  Default: [0x0b] (just "end"). */
  body?: number[];
}

export interface TestImportConfig {
  module: string;
  name: string;
  typeIdx: number;
}

export interface TestGlobalConfig {
  type: number; // 0x7f=i32, 0x7c=f64
  mutable: boolean;
  name: string;
  init?: number[]; // init expression bytes (without end byte). Default: [0x41, 0x00] (i32.const 0)
  exported?: boolean;
}

export interface TestMemoryConfig {
  min: number;
  max?: number;
}

export interface TestObjectConfig {
  name: string;
  types?: { params: number[]; results: number[] }[];
  functions?: TestFuncConfig[];
  imports?: TestImportConfig[];
  globals?: TestGlobalConfig[];
  memories?: TestMemoryConfig[];
  /** Extra symbols to add (e.g. for testing isolation violations) */
  extraSymbols?: {
    kind: number;
    name: string;
    index: number;
    flags: number;
  }[];
}

// ── Builder ───────────────────────────────────────────────────────

/**
 * Build a minimal valid .o wasm file for testing the linker.
 *
 * Produces a valid wasm binary with:
 * - Type section
 * - Import section (for imported functions)
 * - Function section
 * - Memory section
 * - Global section
 * - Export section
 * - Code section
 * - "linking" custom section with symbol table
 * - "reloc.CODE" custom section for function call relocations
 */
export function buildTestObject(config: TestObjectConfig): Uint8Array {
  const enc = new Encoder();

  // Magic + version
  enc.bytes([0x00, 0x61, 0x73, 0x6d]); // \0asm
  enc.bytes([0x01, 0x00, 0x00, 0x00]); // version 1

  const types = config.types ?? [];
  const functions = config.functions ?? [];
  const imports = config.imports ?? [];
  const globals = config.globals ?? [];
  const memories = config.memories ?? [];

  const numImportFuncs = imports.length;

  // ── Type section ────────────────────────────────────────────
  if (types.length > 0) {
    const typeEnc = new Encoder();
    typeEnc.u32(types.length);
    for (const t of types) {
      typeEnc.byte(0x60); // func type
      typeEnc.u32(t.params.length);
      for (const p of t.params) typeEnc.byte(p);
      typeEnc.u32(t.results.length);
      for (const r of t.results) typeEnc.byte(r);
    }
    enc.section(SECTION_TYPE, typeEnc.finish());
  }

  // ── Import section ──────────────────────────────────────────
  if (imports.length > 0) {
    const impEnc = new Encoder();
    impEnc.u32(imports.length);
    for (const imp of imports) {
      impEnc.name(imp.module);
      impEnc.name(imp.name);
      impEnc.byte(0x00); // func import
      impEnc.u32(imp.typeIdx);
    }
    enc.section(SECTION_IMPORT, impEnc.finish());
  }

  // ── Function section ────────────────────────────────────────
  if (functions.length > 0) {
    const funcEnc = new Encoder();
    funcEnc.u32(functions.length);
    for (const f of functions) {
      funcEnc.u32(f.typeIdx);
    }
    enc.section(SECTION_FUNCTION, funcEnc.finish());
  }

  // ── Memory section ──────────────────────────────────────────
  if (memories.length > 0) {
    const memEnc = new Encoder();
    memEnc.u32(memories.length);
    for (const m of memories) {
      if (m.max !== undefined) {
        memEnc.byte(0x01);
        memEnc.u32(m.min);
        memEnc.u32(m.max);
      } else {
        memEnc.byte(0x00);
        memEnc.u32(m.min);
      }
    }
    enc.section(SECTION_MEMORY, memEnc.finish());
  }

  // ── Global section ──────────────────────────────────────────
  if (globals.length > 0) {
    const globalEnc = new Encoder();
    globalEnc.u32(globals.length);
    for (const g of globals) {
      globalEnc.byte(g.type);
      globalEnc.byte(g.mutable ? 0x01 : 0x00);
      const initBytes = g.init ?? [0x41, 0x00]; // i32.const 0
      globalEnc.bytes(initBytes);
      globalEnc.byte(0x0b); // end
    }
    enc.section(SECTION_GLOBAL, globalEnc.finish());
  }

  // ── Export section ──────────────────────────────────────────
  const funcExports = functions.map((f, i) => ({ ...f, localIdx: i })).filter((f) => f.exported);
  const globalExports = globals.map((g, i) => ({ ...g, localIdx: i })).filter((g) => g.exported);
  const totalExports = funcExports.length + globalExports.length;

  if (totalExports > 0) {
    const expEnc = new Encoder();
    expEnc.u32(totalExports);
    for (const f of funcExports) {
      expEnc.name(f.name);
      expEnc.byte(0x00); // func export
      expEnc.u32(f.localIdx + numImportFuncs); // absolute func index
    }
    for (const g of globalExports) {
      expEnc.name(g.name);
      expEnc.byte(0x03); // global export
      expEnc.u32(g.localIdx); // global index
    }
    enc.section(SECTION_EXPORT, expEnc.finish());
  }

  // ── Code section ────────────────────────────────────────────
  if (functions.length > 0) {
    const codeEnc = new Encoder();
    codeEnc.u32(functions.length);
    for (const f of functions) {
      const bodyEnc = new Encoder();
      bodyEnc.u32(0); // 0 local declarations
      const bodyBytes = f.body ?? [];
      bodyEnc.bytes(bodyBytes);
      bodyEnc.byte(0x0b); // end
      const bodyData = bodyEnc.finish();
      codeEnc.u32(bodyData.length);
      codeEnc.bytes(bodyData);
    }
    enc.section(SECTION_CODE, codeEnc.finish());
  }

  // ── "linking" custom section ────────────────────────────────
  {
    const linkEnc = new Encoder();
    linkEnc.u32(2); // linking version 2

    // Build symbol table
    const symEnc = new Encoder();
    const symbols: {
      kind: number;
      name: string;
      index: number;
      flags: number;
    }[] = [];

    // Add symbols for imported functions (undefined)
    for (let i = 0; i < imports.length; i++) {
      symbols.push({
        kind: SYMTAB_FUNCTION,
        name: imports[i]!.name,
        index: i,
        flags: SYMBOL_UNDEFINED,
      });
    }

    // Add symbols for local functions
    for (let i = 0; i < functions.length; i++) {
      const f = functions[i]!;
      let flags = 0;
      if (f.exported) flags |= SYMBOL_EXPORTED;
      symbols.push({
        kind: SYMTAB_FUNCTION,
        name: f.name,
        index: i + numImportFuncs,
        flags,
      });
    }

    // Add symbols for globals
    for (let i = 0; i < globals.length; i++) {
      const g = globals[i]!;
      let flags = 0;
      if (g.exported) flags |= SYMBOL_EXPORTED;
      symbols.push({
        kind: SYMTAB_GLOBAL,
        name: g.name,
        index: i,
        flags,
      });
    }

    // Add extra symbols
    if (config.extraSymbols) {
      for (const s of config.extraSymbols) {
        symbols.push(s);
      }
    }

    symEnc.u32(symbols.length);
    for (const sym of symbols) {
      symEnc.byte(sym.kind);
      symEnc.u32(sym.flags);
      switch (sym.kind) {
        case SYMTAB_FUNCTION:
        case SYMTAB_GLOBAL:
        case SYMTAB_EVENT:
        case SYMTAB_TABLE: {
          symEnc.u32(sym.index);
          if (!(sym.flags & SYMBOL_UNDEFINED)) {
            symEnc.name(sym.name);
          } else if (sym.flags & SYMBOL_EXPLICIT_NAME) {
            symEnc.name(sym.name);
          } else {
            // For undefined function/global symbols without EXPLICIT_NAME,
            // the name is not written in the symbol table.
            // But we want our test symbols to have names for resolution.
            // Use EXPLICIT_NAME flag for undefined symbols that need names.
          }
          break;
        }
        case SYMTAB_DATA: {
          symEnc.name(sym.name);
          if (!(sym.flags & SYMBOL_UNDEFINED)) {
            symEnc.u32(0); // segment index
            symEnc.u32(0); // offset
            symEnc.u32(0); // size
          }
          break;
        }
        case SYMTAB_SECTION: {
          symEnc.u32(sym.index);
          break;
        }
      }
    }

    const symData = symEnc.finish();
    linkEnc.byte(WASM_SYMBOL_TABLE);
    linkEnc.u32(symData.length);
    linkEnc.bytes(symData);

    // Build the custom section payload
    const nameEnc = new Encoder();
    nameEnc.name("linking");
    nameEnc.bytes(linkEnc.finish());

    enc.section(SECTION_CUSTOM, nameEnc.finish());
  }

  return enc.finish();
}

/**
 * Build a test object with undefined symbols that use EXPLICIT_NAME flag
 * so they can be resolved by name in the linker.
 */
export function buildTestObjectWithNamedImports(config: TestObjectConfig): Uint8Array {
  // Override import symbols to use EXPLICIT_NAME flag
  const enriched: TestObjectConfig = {
    ...config,
    // We'll handle this in a modified version
  };

  const enc = new Encoder();

  // Magic + version
  enc.bytes([0x00, 0x61, 0x73, 0x6d]);
  enc.bytes([0x01, 0x00, 0x00, 0x00]);

  const types = config.types ?? [];
  const functions = config.functions ?? [];
  const imports = config.imports ?? [];
  const globals = config.globals ?? [];
  const memories = config.memories ?? [];

  const numImportFuncs = imports.length;

  // ── Type section ────────────────────────────────────────────
  if (types.length > 0) {
    const typeEnc = new Encoder();
    typeEnc.u32(types.length);
    for (const t of types) {
      typeEnc.byte(0x60);
      typeEnc.u32(t.params.length);
      for (const p of t.params) typeEnc.byte(p);
      typeEnc.u32(t.results.length);
      for (const r of t.results) typeEnc.byte(r);
    }
    enc.section(SECTION_TYPE, typeEnc.finish());
  }

  // ── Import section ──────────────────────────────────────────
  if (imports.length > 0) {
    const impEnc = new Encoder();
    impEnc.u32(imports.length);
    for (const imp of imports) {
      impEnc.name(imp.module);
      impEnc.name(imp.name);
      impEnc.byte(0x00);
      impEnc.u32(imp.typeIdx);
    }
    enc.section(SECTION_IMPORT, impEnc.finish());
  }

  // ── Function section ────────────────────────────────────────
  if (functions.length > 0) {
    const funcEnc = new Encoder();
    funcEnc.u32(functions.length);
    for (const f of functions) {
      funcEnc.u32(f.typeIdx);
    }
    enc.section(SECTION_FUNCTION, funcEnc.finish());
  }

  // ── Memory section ──────────────────────────────────────────
  if (memories.length > 0) {
    const memEnc = new Encoder();
    memEnc.u32(memories.length);
    for (const m of memories) {
      if (m.max !== undefined) {
        memEnc.byte(0x01);
        memEnc.u32(m.min);
        memEnc.u32(m.max);
      } else {
        memEnc.byte(0x00);
        memEnc.u32(m.min);
      }
    }
    enc.section(SECTION_MEMORY, memEnc.finish());
  }

  // ── Global section ──────────────────────────────────────────
  if (globals.length > 0) {
    const globalEnc = new Encoder();
    globalEnc.u32(globals.length);
    for (const g of globals) {
      globalEnc.byte(g.type);
      globalEnc.byte(g.mutable ? 0x01 : 0x00);
      const initBytes = g.init ?? [0x41, 0x00];
      globalEnc.bytes(initBytes);
      globalEnc.byte(0x0b);
    }
    enc.section(SECTION_GLOBAL, globalEnc.finish());
  }

  // ── Export section ──────────────────────────────────────────
  const funcExports = functions.map((f, i) => ({ ...f, localIdx: i })).filter((f) => f.exported);
  const globalExports = globals.map((g, i) => ({ ...g, localIdx: i })).filter((g) => g.exported);
  const totalExports = funcExports.length + globalExports.length;

  if (totalExports > 0) {
    const expEnc = new Encoder();
    expEnc.u32(totalExports);
    for (const f of funcExports) {
      expEnc.name(f.name);
      expEnc.byte(0x00);
      expEnc.u32(f.localIdx + numImportFuncs);
    }
    for (const g of globalExports) {
      expEnc.name(g.name);
      expEnc.byte(0x03);
      expEnc.u32(g.localIdx);
    }
    enc.section(SECTION_EXPORT, expEnc.finish());
  }

  // ── Code section ────────────────────────────────────────────
  if (functions.length > 0) {
    const codeEnc = new Encoder();
    codeEnc.u32(functions.length);
    for (const f of functions) {
      const bodyEnc = new Encoder();
      bodyEnc.u32(0);
      const bodyBytes = f.body ?? [];
      bodyEnc.bytes(bodyBytes);
      bodyEnc.byte(0x0b);
      const bodyData = bodyEnc.finish();
      codeEnc.u32(bodyData.length);
      codeEnc.bytes(bodyData);
    }
    enc.section(SECTION_CODE, codeEnc.finish());
  }

  // ── "linking" custom section with EXPLICIT_NAME for imports ──
  {
    const linkEnc = new Encoder();
    linkEnc.u32(2);

    const symEnc = new Encoder();
    const symbols: {
      kind: number;
      name: string;
      index: number;
      flags: number;
    }[] = [];

    // Import symbols with EXPLICIT_NAME so the name gets encoded
    for (let i = 0; i < imports.length; i++) {
      symbols.push({
        kind: SYMTAB_FUNCTION,
        name: imports[i]!.name,
        index: i,
        flags: SYMBOL_UNDEFINED | SYMBOL_EXPLICIT_NAME,
      });
    }

    // Local function symbols
    for (let i = 0; i < functions.length; i++) {
      const f = functions[i]!;
      let flags = 0;
      if (f.exported) flags |= SYMBOL_EXPORTED;
      symbols.push({
        kind: SYMTAB_FUNCTION,
        name: f.name,
        index: i + numImportFuncs,
        flags,
      });
    }

    // Global symbols
    for (let i = 0; i < globals.length; i++) {
      const g = globals[i]!;
      let flags = 0;
      if (g.exported) flags |= SYMBOL_EXPORTED;
      symbols.push({
        kind: SYMTAB_GLOBAL,
        name: g.name,
        index: i,
        flags,
      });
    }

    // Extra symbols
    if (config.extraSymbols) {
      for (const s of config.extraSymbols) {
        symbols.push(s);
      }
    }

    symEnc.u32(symbols.length);
    for (const sym of symbols) {
      symEnc.byte(sym.kind);
      symEnc.u32(sym.flags);
      switch (sym.kind) {
        case SYMTAB_FUNCTION:
        case SYMTAB_GLOBAL:
        case SYMTAB_EVENT:
        case SYMTAB_TABLE: {
          symEnc.u32(sym.index);
          // For undefined + EXPLICIT_NAME: write the name
          // For defined (not undefined): always write the name
          if (!(sym.flags & SYMBOL_UNDEFINED) || sym.flags & SYMBOL_EXPLICIT_NAME) {
            symEnc.name(sym.name);
          }
          break;
        }
        case SYMTAB_DATA: {
          symEnc.name(sym.name);
          if (!(sym.flags & SYMBOL_UNDEFINED)) {
            symEnc.u32(0);
            symEnc.u32(0);
            symEnc.u32(0);
          }
          break;
        }
        case SYMTAB_SECTION: {
          symEnc.u32(sym.index);
          break;
        }
      }
    }

    const symData = symEnc.finish();
    linkEnc.byte(WASM_SYMBOL_TABLE);
    linkEnc.u32(symData.length);
    linkEnc.bytes(symData);

    const nameEnc = new Encoder();
    nameEnc.name("linking");
    nameEnc.bytes(linkEnc.finish());

    enc.section(SECTION_CUSTOM, nameEnc.finish());
  }

  return enc.finish();
}
