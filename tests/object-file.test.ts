import { describe, it, expect } from "vitest";
import { compileToObject } from "../src/index.js";
import { type RelocEntry, type SymbolInfo } from "../src/emit/object.js";
import { RELOC, SYM_FLAGS, SYMTAB, LINKING_SUBSECTION } from "../src/emit/opcodes.js";
import { compile } from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Read an unsigned LEB128 value from a byte array at the given offset.
 *  Returns [value, bytesConsumed]. */
function readULEB128(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    const byte = bytes[pos]!;
    result |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos - offset];
}

/** Read a UTF-8 string with LEB128 length prefix */
function readName(bytes: Uint8Array, offset: number): [string, number] {
  const [len, lenSize] = readULEB128(bytes, offset);
  const strBytes = bytes.slice(offset + lenSize, offset + lenSize + len);
  const str = new TextDecoder().decode(strBytes);
  return [str, lenSize + len];
}

interface ParsedSection {
  id: number;
  name?: string; // for custom sections
  offset: number; // byte offset of section payload in the binary
  size: number;
  payload: Uint8Array;
}

/** Parse all sections from a wasm binary */
function parseSections(binary: Uint8Array): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let pos = 8; // skip magic + version

  while (pos < binary.length) {
    const id = binary[pos]!;
    pos++;
    const [size, sizeLen] = readULEB128(binary, pos);
    pos += sizeLen;
    const payloadStart = pos;
    const payload = binary.slice(pos, pos + size);
    pos += size;

    let name: string | undefined;
    if (id === 0) {
      // Custom section: read name
      const [n] = readName(payload, 0);
      name = n;
    }

    sections.push({ id, name, offset: payloadStart, size, payload });
  }

  return sections;
}

/** Find a custom section by name */
function findCustomSection(sections: ParsedSection[], name: string): ParsedSection | undefined {
  return sections.find((s) => s.id === 0 && s.name === name);
}

/** Parse the reloc.CODE section payload */
function parseRelocSection(payload: Uint8Array): {
  sectionIndex: number;
  entries: RelocEntry[];
} {
  let pos = 0;
  // Skip the section name
  const [, nameLen] = readName(payload, pos);
  pos += nameLen;

  const [sectionIndex, siLen] = readULEB128(payload, pos);
  pos += siLen;
  const [count, countLen] = readULEB128(payload, pos);
  pos += countLen;

  const entries: RelocEntry[] = [];
  for (let i = 0; i < count; i++) {
    const type = payload[pos]!;
    pos++;
    const [offset, offLen] = readULEB128(payload, pos);
    pos += offLen;
    const [symbolIndex, symLen] = readULEB128(payload, pos);
    pos += symLen;
    entries.push({ type, offset, symbolIndex });
  }

  return { sectionIndex, entries };
}

/** Parse the linking section payload to extract symbol table */
function parseLinkingSection(payload: Uint8Array): {
  version: number;
  symbols: SymbolInfo[];
} {
  let pos = 0;
  // Skip name
  const [, nameLen] = readName(payload, pos);
  pos += nameLen;

  const [version, versionLen] = readULEB128(payload, pos);
  pos += versionLen;

  const symbols: SymbolInfo[] = [];

  while (pos < payload.length) {
    const subsectionType = payload[pos]!;
    pos++;
    const [subsectionSize, ssLen] = readULEB128(payload, pos);
    pos += ssLen;

    if (subsectionType === LINKING_SUBSECTION.WASM_SYMBOL_TABLE) {
      const [count, countLen] = readULEB128(payload, pos);
      pos += countLen;

      for (let i = 0; i < count; i++) {
        const kind = payload[pos]!;
        pos++;
        const [flags, flagsLen] = readULEB128(payload, pos);
        pos += flagsLen;
        const [index, indexLen] = readULEB128(payload, pos);
        pos += indexLen;

        let symName = "";
        if (!(flags & SYM_FLAGS.WASM_SYM_UNDEFINED)) {
          const [n, nLen] = readName(payload, pos);
          symName = n;
          pos += nLen;
        }

        symbols.push({ kind, flags, index, name: symName });
      }
    } else {
      pos += subsectionSize;
    }
  }

  return { version, symbols };
}

// ── Tests ────────────────────────────────────────────────────────────

// Use a shared compilation result to avoid repeated TS compilation overhead.
// Each describe block compiles once and runs multiple assertions.

describe("Object file emission", () => {
  // Compile shared test programs once (each test uses the same result)
  let addResult: ReturnType<typeof compileToObject>;
  let callResult: ReturnType<typeof compileToObject>;
  let classResult: ReturnType<typeof compileToObject>;
  let importResult: ReturnType<typeof compileToObject>;

  // Compile all test programs up front
  it("compiles test programs", { timeout: 30000 }, () => {
    addResult = compileToObject(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `);
    expect(addResult.success).toBe(true);

    callResult = compileToObject(`
      function helper(x: number): number {
        return x + 1;
      }
      export function main(): number {
        return helper(42);
      }
    `);
    expect(callResult.success).toBe(true);

    classResult = compileToObject(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function makePoint(): number {
        const p = new Point(1, 2);
        return p.x + p.y;
      }
    `);
    expect(classResult.success).toBe(true);

    // Use console.log which generates env imports in this compiler
    importResult = compileToObject(`
      export function greet(x: number): void {
        console.log(x);
      }
    `);
    expect(importResult.success).toBe(true);
  });

  it("starts with wasm magic bytes", () => {
    const bytes = addResult.object;
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x61);
    expect(bytes[2]).toBe(0x73);
    expect(bytes[3]).toBe(0x6d);
    expect(bytes[4]).toBe(0x01);
    expect(bytes[5]).toBe(0x00);
    expect(bytes[6]).toBe(0x00);
    expect(bytes[7]).toBe(0x00);
  });

  it("contains linking custom section", () => {
    const sections = parseSections(addResult.object);
    const linking = findCustomSection(sections, "linking");
    expect(linking).toBeDefined();
  });

  it("linking section version is 2", () => {
    const sections = parseSections(addResult.object);
    const linking = findCustomSection(sections, "linking")!;
    const { version } = parseLinkingSection(linking.payload);
    expect(version).toBe(2);
  });

  it("symbol table has correct entries for exported function", () => {
    const sections = parseSections(addResult.object);
    const linking = findCustomSection(sections, "linking")!;
    const { symbols } = parseLinkingSection(linking.payload);

    const funcSymbols = symbols.filter((s) => s.kind === SYMTAB.SYMTAB_FUNCTION);
    expect(funcSymbols.length).toBeGreaterThanOrEqual(1);

    const addSym = funcSymbols.find((s) => s.name === "add");
    expect(addSym).toBeDefined();
    expect(addSym!.flags & SYM_FLAGS.WASM_SYM_EXPORTED).toBeTruthy();
  });

  it("symbol table has imported function marked UNDEFINED", () => {
    const sections = parseSections(importResult.object);
    const linking = findCustomSection(sections, "linking")!;
    const { symbols } = parseLinkingSection(linking.payload);

    // console.log(number) creates an import like console_log_number
    const undefinedSyms = symbols.filter(
      (s) => s.kind === SYMTAB.SYMTAB_FUNCTION && (s.flags & SYM_FLAGS.WASM_SYM_UNDEFINED) !== 0,
    );
    expect(undefinedSyms.length).toBeGreaterThanOrEqual(1);

    // The "greet" function should be defined and exported
    const greetSym = symbols.find(
      (s) => s.kind === SYMTAB.SYMTAB_FUNCTION && s.name === "greet",
    );
    expect(greetSym).toBeDefined();
    expect(greetSym!.flags & SYM_FLAGS.WASM_SYM_EXPORTED).toBeTruthy();
  });

  it("has relocation entries for call instructions", () => {
    const sections = parseSections(callResult.object);
    const relocSec = findCustomSection(sections, "reloc.CODE");
    expect(relocSec).toBeDefined();

    const { entries } = parseRelocSection(relocSec!.payload);
    const funcRelocs = entries.filter((r) => r.type === RELOC.R_WASM_FUNCTION_INDEX_LEB);
    expect(funcRelocs.length).toBeGreaterThanOrEqual(1);
  });

  it("has type index relocations for struct/array GC instructions", () => {
    const sections = parseSections(classResult.object);
    const relocSec = findCustomSection(sections, "reloc.CODE");
    expect(relocSec).toBeDefined();

    const { entries } = parseRelocSection(relocSec!.payload);
    const typeRelocs = entries.filter((r) => r.type === RELOC.R_WASM_TYPE_INDEX_LEB);
    expect(typeRelocs.length).toBeGreaterThanOrEqual(1);
  });

  it("functions with no cross-references still get symbol entries", () => {
    const sections = parseSections(addResult.object);
    const linking = findCustomSection(sections, "linking")!;
    const { symbols } = parseLinkingSection(linking.payload);

    const funcSymbols = symbols.filter((s) => s.kind === SYMTAB.SYMTAB_FUNCTION);
    expect(funcSymbols.length).toBeGreaterThanOrEqual(1);

    const addSym = funcSymbols.find((s) => s.name === "add");
    expect(addSym).toBeDefined();
  });

  it("local (non-exported) helper gets BINDING_LOCAL flag", () => {
    const sections = parseSections(callResult.object);
    const linking = findCustomSection(sections, "linking")!;
    const { symbols } = parseLinkingSection(linking.payload);

    const helperSym = symbols.find(
      (s) => s.kind === SYMTAB.SYMTAB_FUNCTION && s.name === "helper",
    );
    expect(helperSym).toBeDefined();
    expect(helperSym!.flags & SYM_FLAGS.WASM_SYM_BINDING_LOCAL).toBeTruthy();
  });

  it("reloc.CODE section references the correct code section index", () => {
    const sections = parseSections(callResult.object);
    const relocSec = findCustomSection(sections, "reloc.CODE");
    expect(relocSec).toBeDefined();

    const { sectionIndex } = parseRelocSection(relocSec!.payload);
    const codeSec = sections.find((s) => s.id === 10);
    expect(codeSec).toBeDefined();

    // The section index should match the ordinal position of the code section
    const codeSectionOrdinal = sections.indexOf(codeSec!);
    expect(sectionIndex).toBe(codeSectionOrdinal);
  });

  it("existing emitBinary still works the same", { timeout: 15000 }, () => {
    const result = compile(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.binary.length).toBeGreaterThan(8);
    expect(result.binary[0]).toBe(0x00);
    expect(result.binary[1]).toBe(0x61);
    expect(result.binary[2]).toBe(0x73);
    expect(result.binary[3]).toBe(0x6d);
  });
});
