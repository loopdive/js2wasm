// WASM Binary Treemap — embeddable module
// Parses .wasm binaries and renders an interactive treemap visualization.

// ─── Types ──────────────────────────────────────────────────────────────

export interface WasmSection {
  id: number;
  name: string;
  offset: number;
  headerSize: number;
  dataSize: number;
  totalSize: number;
  customName?: string | null;
}

interface WasmImport {
  module: string;
  name: string;
  kind: string;
  index: number;
  size: number;
}

interface WasmExport {
  name: string;
  kind: string;
  index: number;
}

export interface WasmFunctionBody {
  index: number;
  bodySize: number;
  totalSize: number;
  offset: number;
}

export interface WasmData {
  fileSize: number;
  version: number;
  headerSize: number;
  sections: WasmSection[];
  functionNames: Map<number, string>;
  imports: WasmImport[];
  exports: WasmExport[];
  functionBodies: WasmFunctionBody[];
  typeCount: number;
  importFuncCount: number;
  exportNames: Map<number, string>;
}

interface TreeNode {
  _id: number;
  _originalId?: number;
  name: string;
  children: Record<string, TreeNode>;
  size: number;
  fullPath: string;
  isLeaf: boolean;
  isRemainder: boolean;
  remainderCount?: number;
  isRoot?: boolean;
}

interface LayoutItem {
  size: number;
  node: TreeNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

type ViewMode = "sections" | "functions";

// ─── Section names ──────────────────────────────────────────────────────

const SECTION_NAMES: Record<number, string> = {
  0: "custom",
  1: "type",
  2: "import",
  3: "function",
  4: "table",
  5: "memory",
  6: "global",
  7: "export",
  8: "start",
  9: "element",
  10: "code",
  11: "data",
  12: "datacount",
};

// ─── Fixed section colors ───────────────────────────────────────────────

export const SECTION_COLORS: Record<string, [number, number, number]> = {
  code: [70, 140, 200],
  type: [180, 100, 60],
  import: [100, 170, 80],
  export: [200, 160, 50],
  data: [160, 80, 160],
  function: [80, 160, 160],
  table: [200, 100, 100],
  memory: [100, 100, 200],
  global: [150, 150, 80],
  element: [80, 150, 130],
  start: [180, 120, 80],
  custom: [120, 120, 140],
  datacount: [130, 100, 150],
  header: [60, 60, 80],
};

const HUE_PALETTE: [number, number, number][] = (() => {
  const colors: [number, number, number][] = [];
  const golden = 137.508;
  for (let i = 0; i < 40; i++) {
    const h = (i * golden) % 360;
    const s = 0.75,
      l = 0.55;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r: number, g: number, b: number;
    if (h < 60) {
      r = c;
      g = x;
      b = 0;
    } else if (h < 120) {
      r = x;
      g = c;
      b = 0;
    } else if (h < 180) {
      r = 0;
      g = c;
      b = x;
    } else if (h < 240) {
      r = 0;
      g = x;
      b = c;
    } else if (h < 300) {
      r = x;
      g = 0;
      b = c;
    } else {
      r = c;
      g = 0;
      b = x;
    }
    colors.push([
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ]);
  }
  return colors;
})();

// ─── LEB128 decoders ────────────────────────────────────────────────────

function readU32Leb(
  bytes: Uint8Array,
  offset: number,
): { value: number; next: number } {
  let result = 0,
    shift = 0,
    pos = offset;
  while (true) {
    const byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, next: pos };
}

function readS32Leb(
  bytes: Uint8Array,
  offset: number,
): { value: number; next: number } {
  let result = 0,
    shift = 0,
    pos = offset;
  let byte: number;
  do {
    byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (shift < 32 && byte & 0x40) result |= -(1 << shift);
  return { value: result, next: pos };
}

function readS64Leb(
  bytes: Uint8Array,
  offset: number,
): { value: bigint; next: number } {
  let result = 0n,
    shift = 0n,
    pos = offset;
  let byte: number;
  do {
    byte = bytes[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  if (shift < 64n && byte & 0x40) result |= -(1n << shift);
  return { value: result, next: pos };
}

function readName(
  bytes: Uint8Array,
  offset: number,
): { value: string; next: number } {
  const { value: len, next: p } = readU32Leb(bytes, offset);
  const nameBytes = bytes.slice(p, p + len);
  return { value: new TextDecoder().decode(nameBytes), next: p + len };
}

// ─── WASM binary parser ─────────────────────────────────────────────────

export function parseWasm(buffer: ArrayBuffer): WasmData {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8) throw new Error("File too small to be a valid .wasm");

  const magic =
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d;
  if (!magic) throw new Error("Invalid WASM magic bytes");

  const version =
    bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);

  const result: WasmData = {
    fileSize: bytes.length,
    version,
    headerSize: 8,
    sections: [],
    functionNames: new Map(),
    imports: [],
    exports: [],
    functionBodies: [],
    typeCount: 0,
    importFuncCount: 0,
    exportNames: new Map(),
  };

  let pos = 8;

  while (pos < bytes.length) {
    const sectionId = bytes[pos++];
    const { value: sectionSize, next: dataStart } = readU32Leb(bytes, pos);
    const overhead = dataStart - (pos - 1);
    const sectionEnd = dataStart + sectionSize;

    const sectionName = SECTION_NAMES[sectionId] || `unknown_${sectionId}`;
    const section: WasmSection = {
      id: sectionId,
      name: sectionName,
      offset: pos - 1,
      headerSize: overhead,
      dataSize: sectionSize,
      totalSize: overhead + sectionSize,
      customName: null,
    };

    if (sectionId === 0) {
      const { value: cname } = readName(bytes, dataStart);
      section.customName = cname;
      section.name = `custom:"${cname}"`;
    }

    if (sectionId === 1) {
      const { value: count } = readU32Leb(bytes, dataStart);
      result.typeCount = count;
    }

    if (sectionId === 2) {
      let p = dataStart;
      const { value: count, next: p2 } = readU32Leb(bytes, p);
      p = p2;
      let funcIdx = 0;
      for (let i = 0; i < count; i++) {
        const importStart = p;
        const { value: mod, next: p3 } = readName(bytes, p);
        p = p3;
        const { value: name, next: p4 } = readName(bytes, p);
        p = p4;
        const kind = bytes[p++];
        if (kind === 0) {
          const { next: p5 } = readU32Leb(bytes, p);
          p = p5;
          result.imports.push({
            module: mod,
            name,
            kind: "func",
            index: funcIdx++,
            size: p - importStart,
          });
        } else if (kind === 1) {
          p++; // reftype
          const { value: flags, next: p5 } = readU32Leb(bytes, p);
          p = p5;
          const { next: p6 } = readU32Leb(bytes, p);
          p = p6;
          if (flags & 1) {
            const { next: p7 } = readU32Leb(bytes, p);
            p = p7;
          }
          result.imports.push({
            module: mod,
            name,
            kind: "table",
            index: i,
            size: p - importStart,
          });
        } else if (kind === 2) {
          const { value: flags, next: p5 } = readU32Leb(bytes, p);
          p = p5;
          const { next: p6 } = readU32Leb(bytes, p);
          p = p6;
          if (flags & 1) {
            const { next: p7 } = readU32Leb(bytes, p);
            p = p7;
          }
          result.imports.push({
            module: mod,
            name,
            kind: "memory",
            index: i,
            size: p - importStart,
          });
        } else if (kind === 3) {
          p++; // valtype
          p++; // mutability
          result.imports.push({
            module: mod,
            name,
            kind: "global",
            index: i,
            size: p - importStart,
          });
        }
      }
      result.importFuncCount = funcIdx;
    }

    if (sectionId === 7) {
      let p = dataStart;
      const { value: count, next: p2 } = readU32Leb(bytes, p);
      p = p2;
      for (let i = 0; i < count; i++) {
        const { value: name, next: p3 } = readName(bytes, p);
        p = p3;
        const kind = bytes[p++];
        const EXPORT_KIND: Record<number, string> = {
          0: "func",
          1: "table",
          2: "memory",
          3: "global",
        };
        const { value: index, next: p4 } = readU32Leb(bytes, p);
        p = p4;
        result.exports.push({
          name,
          kind: EXPORT_KIND[kind] || `kind_${kind}`,
          index,
        });
      }
    }

    if (sectionId === 10) {
      let p = dataStart;
      const { value: count, next: p2 } = readU32Leb(bytes, p);
      p = p2;
      for (let i = 0; i < count; i++) {
        const bodyStart = p;
        const { value: bodySize, next: codeStart } = readU32Leb(bytes, p);
        const headerBytes = codeStart - bodyStart;
        result.functionBodies.push({
          index: i,
          bodySize,
          totalSize: headerBytes + bodySize,
          offset: bodyStart,
        });
        p = codeStart + bodySize;
      }
    }

    if (sectionId === 0 && section.customName === "name") {
      try {
        const { next: afterName } = readName(bytes, dataStart);
        let p = afterName;
        while (p < sectionEnd) {
          const subId = bytes[p++];
          const { value: subSize, next: subStart } = readU32Leb(bytes, p);
          p = subStart;
          if (subId === 1) {
            let sp = p;
            const { value: nameCount, next: sp2 } = readU32Leb(bytes, sp);
            sp = sp2;
            for (let i = 0; i < nameCount && sp < p + subSize; i++) {
              const { value: funcIndex, next: sp3 } = readU32Leb(bytes, sp);
              sp = sp3;
              const { value: funcName, next: sp4 } = readName(bytes, sp);
              sp = sp4;
              result.functionNames.set(funcIndex, funcName);
            }
          }
          p += subSize;
        }
      } catch {
        /* name section parsing is best-effort */
      }
    }

    result.sections.push(section);
    pos = sectionEnd;
  }

  for (const exp of result.exports) {
    if (exp.kind === "func") {
      result.exportNames.set(exp.index, exp.name);
    }
  }

  return result;
}

// ─── Byte-level span parser ─────────────────────────────────────────────

export interface ByteSpan {
  offset: number;
  length: number;
  label: string;
  value?: string;
}

const VALTYPE_NAMES: Record<number, string> = {
  0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64",
  0x70: "funcref", 0x6f: "externref",
};

// Immediate kinds
const N = "none";   // no immediate
const L = "leb";    // unsigned LEB128
const SL = "sleb";  // signed LEB128 (i32)
const SL64 = "sleb64"; // signed LEB128 (i64)
const F32 = "f32";
const F64 = "f64";
const MEM = "mem";   // memarg: align + offset
const BLK = "block"; // block type
const BRT = "br_table";
const CI = "call_indirect";
const B = "byte";    // single byte (memory index)

type ImmKind = typeof N | typeof L | typeof SL | typeof SL64 |
  typeof F32 | typeof F64 | typeof MEM | typeof BLK |
  typeof BRT | typeof CI | typeof B;

const OPCODES: [number, string, ImmKind][] = [
  [0x00, "unreachable", N], [0x01, "nop", N],
  [0x02, "block", BLK], [0x03, "loop", BLK], [0x04, "if", BLK],
  [0x05, "else", N], [0x0b, "end", N],
  [0x0c, "br", L], [0x0d, "br_if", L], [0x0e, "br_table", BRT],
  [0x0f, "return", N],
  [0x10, "call", L], [0x11, "call_indirect", CI],
  [0x1a, "drop", N], [0x1b, "select", N],
  [0x20, "local.get", L], [0x21, "local.set", L], [0x22, "local.tee", L],
  [0x23, "global.get", L], [0x24, "global.set", L],
  [0x25, "table.get", L], [0x26, "table.set", L],
  [0x28, "i32.load", MEM], [0x29, "i64.load", MEM],
  [0x2a, "f32.load", MEM], [0x2b, "f64.load", MEM],
  [0x2c, "i32.load8_s", MEM], [0x2d, "i32.load8_u", MEM],
  [0x2e, "i32.load16_s", MEM], [0x2f, "i32.load16_u", MEM],
  [0x30, "i64.load8_s", MEM], [0x31, "i64.load8_u", MEM],
  [0x32, "i64.load16_s", MEM], [0x33, "i64.load16_u", MEM],
  [0x34, "i64.load32_s", MEM], [0x35, "i64.load32_u", MEM],
  [0x36, "i32.store", MEM], [0x37, "i64.store", MEM],
  [0x38, "f32.store", MEM], [0x39, "f64.store", MEM],
  [0x3a, "i32.store8", MEM], [0x3b, "i32.store16", MEM],
  [0x3c, "i64.store8", MEM], [0x3d, "i64.store16", MEM],
  [0x3e, "i64.store32", MEM],
  [0x3f, "memory.size", B], [0x40, "memory.grow", B],
  [0x41, "i32.const", SL], [0x42, "i64.const", SL64],
  [0x43, "f32.const", F32], [0x44, "f64.const", F64],
  [0x45, "i32.eqz", N], [0x46, "i32.eq", N], [0x47, "i32.ne", N],
  [0x48, "i32.lt_s", N], [0x49, "i32.lt_u", N],
  [0x4a, "i32.gt_s", N], [0x4b, "i32.gt_u", N],
  [0x4c, "i32.le_s", N], [0x4d, "i32.le_u", N],
  [0x4e, "i32.ge_s", N], [0x4f, "i32.ge_u", N],
  [0x50, "i64.eqz", N], [0x51, "i64.eq", N], [0x52, "i64.ne", N],
  [0x53, "i64.lt_s", N], [0x54, "i64.lt_u", N],
  [0x55, "i64.gt_s", N], [0x56, "i64.gt_u", N],
  [0x57, "i64.le_s", N], [0x58, "i64.le_u", N],
  [0x59, "i64.ge_s", N], [0x5a, "i64.ge_u", N],
  [0x5b, "f32.eq", N], [0x5c, "f32.ne", N],
  [0x5d, "f32.lt", N], [0x5e, "f32.gt", N],
  [0x5f, "f32.le", N], [0x60, "f32.ge", N],
  [0x61, "f64.eq", N], [0x62, "f64.ne", N],
  [0x63, "f64.lt", N], [0x64, "f64.gt", N],
  [0x65, "f64.le", N], [0x66, "f64.ge", N],
  [0x67, "i32.clz", N], [0x68, "i32.ctz", N], [0x69, "i32.popcnt", N],
  [0x6a, "i32.add", N], [0x6b, "i32.sub", N],
  [0x6c, "i32.mul", N], [0x6d, "i32.div_s", N], [0x6e, "i32.div_u", N],
  [0x6f, "i32.rem_s", N], [0x70, "i32.rem_u", N],
  [0x71, "i32.and", N], [0x72, "i32.or", N], [0x73, "i32.xor", N],
  [0x74, "i32.shl", N], [0x75, "i32.shr_s", N], [0x76, "i32.shr_u", N],
  [0x77, "i32.rotl", N], [0x78, "i32.rotr", N],
  [0x79, "i64.clz", N], [0x7a, "i64.ctz", N], [0x7b, "i64.popcnt", N],
  [0x7c, "i64.add", N], [0x7d, "i64.sub", N],
  [0x7e, "i64.mul", N], [0x7f, "i64.div_s", N], [0x80, "i64.div_u", N],
  [0x81, "i64.rem_s", N], [0x82, "i64.rem_u", N],
  [0x83, "i64.and", N], [0x84, "i64.or", N], [0x85, "i64.xor", N],
  [0x86, "i64.shl", N], [0x87, "i64.shr_s", N], [0x88, "i64.shr_u", N],
  [0x89, "i64.rotl", N], [0x8a, "i64.rotr", N],
  [0x8b, "f32.abs", N], [0x8c, "f32.neg", N],
  [0x8d, "f32.ceil", N], [0x8e, "f32.floor", N],
  [0x8f, "f32.trunc", N], [0x90, "f32.nearest", N],
  [0x91, "f32.sqrt", N],
  [0x92, "f32.add", N], [0x93, "f32.sub", N],
  [0x94, "f32.mul", N], [0x95, "f32.div", N],
  [0x96, "f32.min", N], [0x97, "f32.max", N],
  [0x98, "f32.copysign", N],
  [0x99, "f64.abs", N], [0x9a, "f64.neg", N],
  [0x9b, "f64.ceil", N], [0x9c, "f64.floor", N],
  [0x9d, "f64.trunc", N], [0x9e, "f64.nearest", N],
  [0x9f, "f64.sqrt", N],
  [0xa0, "f64.add", N], [0xa1, "f64.sub", N],
  [0xa2, "f64.mul", N], [0xa3, "f64.div", N],
  [0xa4, "f64.min", N], [0xa5, "f64.max", N],
  [0xa6, "f64.copysign", N],
  [0xa7, "i32.wrap_i64", N],
  [0xa8, "i32.trunc_f32_s", N], [0xa9, "i32.trunc_f32_u", N],
  [0xaa, "i32.trunc_f64_s", N], [0xab, "i32.trunc_f64_u", N],
  [0xac, "i64.extend_i32_s", N], [0xad, "i64.extend_i32_u", N],
  [0xae, "i64.trunc_f32_s", N], [0xaf, "i64.trunc_f32_u", N],
  [0xb0, "i64.trunc_f64_s", N], [0xb1, "i64.trunc_f64_u", N],
  [0xb2, "f32.convert_i32_s", N], [0xb3, "f32.convert_i32_u", N],
  [0xb4, "f32.convert_i64_s", N], [0xb5, "f32.convert_i64_u", N],
  [0xb6, "f32.demote_f64", N],
  [0xb7, "f64.convert_i32_s", N], [0xb8, "f64.convert_i32_u", N],
  [0xb9, "f64.convert_i64_s", N], [0xba, "f64.convert_i64_u", N],
  [0xbb, "f64.promote_f32", N],
  [0xbc, "i32.reinterpret_f32", N], [0xbd, "i64.reinterpret_f64", N],
  [0xbe, "f32.reinterpret_i32", N], [0xbf, "f64.reinterpret_i64", N],
  [0xc0, "i32.extend8_s", N], [0xc1, "i32.extend16_s", N],
  [0xc2, "i64.extend8_s", N], [0xc3, "i64.extend16_s", N],
  [0xc4, "i64.extend32_s", N],
  [0xd0, "ref.null", B], [0xd1, "ref.is_null", N], [0xd2, "ref.func", L],
];

const OPCODE_MAP = new Map<number, { name: string; imm: ImmKind }>();
for (const [code, name, imm] of OPCODES) OPCODE_MAP.set(code, { name, imm });

// FC-prefixed (extended) opcodes — all take LEB128 immediates
const FC_OPCODES: Record<number, string> = {
  0: "i32.trunc_sat_f32_s", 1: "i32.trunc_sat_f32_u",
  2: "i32.trunc_sat_f64_s", 3: "i32.trunc_sat_f64_u",
  4: "i64.trunc_sat_f32_s", 5: "i64.trunc_sat_f32_u",
  6: "i64.trunc_sat_f64_s", 7: "i64.trunc_sat_f64_u",
  8: "memory.init", 9: "data.drop",
  10: "memory.copy", 11: "memory.fill",
  12: "table.init", 13: "elem.drop",
  14: "table.copy", 15: "table.grow", 16: "table.size", 17: "table.fill",
};

export function parseWasmSpans(buffer: ArrayBuffer): ByteSpan[] {
  const bytes = new Uint8Array(buffer);
  const spans: ByteSpan[] = [];

  function span(offset: number, length: number, label: string, value?: string) {
    spans.push({ offset, length, label, value });
  }

  function valtype(b: number): string { return VALTYPE_NAMES[b] ?? `0x${b.toString(16)}`; }

  function spanLeb(offset: number, label: string): number {
    const { value, next } = readU32Leb(bytes, offset);
    span(offset, next - offset, label, String(value));
    return next;
  }

  function spanSleb(offset: number, label: string): number {
    const { value, next } = readS32Leb(bytes, offset);
    span(offset, next - offset, label, String(value));
    return next;
  }

  function spanName(offset: number, label: string): { value: string; next: number } {
    const { value: len, next: p } = readU32Leb(bytes, offset);
    span(offset, p - offset, `${label} length`, String(len));
    const str = new TextDecoder().decode(bytes.slice(p, p + len));
    if (len > 0) span(p, len, label, `"${str}"`);
    return { value: str, next: p + len };
  }

  function spanValtype(offset: number, label: string): number {
    span(offset, 1, label, valtype(bytes[offset]));
    return offset + 1;
  }

  // Parse init expression (const expr ending with 0x0B)
  function parseInitExpr(p: number): number {
    while (p < bytes.length) {
      const op = bytes[p];
      if (op === 0x0b) { span(p, 1, "end"); return p + 1; }
      if (op === 0x41) { // i32.const
        span(p, 1, "i32.const"); p++;
        const { value, next } = readS32Leb(bytes, p);
        span(p, next - p, "value", String(value));
        p = next;
      } else if (op === 0x42) { // i64.const
        span(p, 1, "i64.const"); p++;
        const { value, next } = readS64Leb(bytes, p);
        span(p, next - p, "value", String(value));
        p = next;
      } else if (op === 0x43) { // f32.const
        span(p, 1, "f32.const"); p++;
        const view = new DataView(bytes.buffer, bytes.byteOffset + p, 4);
        span(p, 4, "value", String(view.getFloat32(0, true)));
        p += 4;
      } else if (op === 0x44) { // f64.const
        span(p, 1, "f64.const"); p++;
        const view = new DataView(bytes.buffer, bytes.byteOffset + p, 8);
        span(p, 8, "value", String(view.getFloat64(0, true)));
        p += 8;
      } else if (op === 0x23) { // global.get
        span(p, 1, "global.get"); p++;
        p = spanLeb(p, "global index");
      } else if (op === 0xd2) { // ref.func
        span(p, 1, "ref.func"); p++;
        p = spanLeb(p, "func index");
      } else if (op === 0xd0) { // ref.null
        span(p, 1, "ref.null"); p++;
        span(p, 1, "reftype", valtype(bytes[p])); p++;
      } else {
        // Unknown init opcode, skip to end
        span(p, 1, `opcode 0x${op.toString(16)}`); p++;
      }
    }
    return p;
  }

  if (bytes.length < 8) return spans;

  // Header
  span(0, 4, "magic", "\\0asm");
  const version = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  span(4, 4, "version", String(version));

  let pos = 8;
  while (pos < bytes.length) {
    const sectionStart = pos;
    const sectionId = bytes[pos];
    span(pos, 1, "section id", SECTION_NAMES[sectionId] ?? `unknown(${sectionId})`);
    pos++;
    const { value: sectionSize, next: dataStart } = readU32Leb(bytes, pos);
    span(pos, dataStart - pos, "section size", String(sectionSize));
    const sectionEnd = dataStart + sectionSize;
    let p = dataStart;

    try {
      if (sectionId === 0) {
        // Custom section: name + raw data
        const { next: afterName } = spanName(p, "custom section name");
        p = afterName;
        if (p < sectionEnd) span(p, sectionEnd - p, "custom data");
      } else if (sectionId === 1) {
        // Type section
        const { value: count, next: p2 } = readU32Leb(bytes, p);
        span(p, p2 - p, "type count", String(count));
        p = p2;
        for (let i = 0; i < count && p < sectionEnd; i++) {
          span(p, 1, "func type marker", "0x60"); p++;
          const { value: paramCount, next: p3 } = readU32Leb(bytes, p);
          span(p, p3 - p, "param count", String(paramCount)); p = p3;
          for (let j = 0; j < paramCount; j++) p = spanValtype(p, `param[${j}]`);
          const { value: resultCount, next: p4 } = readU32Leb(bytes, p);
          span(p, p4 - p, "result count", String(resultCount)); p = p4;
          for (let j = 0; j < resultCount; j++) p = spanValtype(p, `result[${j}]`);
        }
      } else if (sectionId === 2) {
        // Import section
        const { value: count, next: p2 } = readU32Leb(bytes, p);
        span(p, p2 - p, "import count", String(count)); p = p2;
        const IMPORT_KIND: Record<number, string> = { 0: "func", 1: "table", 2: "memory", 3: "global", 4: "tag" };
        for (let i = 0; i < count && p < sectionEnd; i++) {
          const { next: p3 } = spanName(p, "module name"); p = p3;
          const { next: p4 } = spanName(p, "field name"); p = p4;
          const kind = bytes[p];
          span(p, 1, "import kind", IMPORT_KIND[kind] ?? String(kind)); p++;
          if (kind === 0) {
            p = spanLeb(p, "type index");
          } else if (kind === 1) {
            p = spanValtype(p, "reftype");
            const { value: flags, next: pf } = readU32Leb(bytes, p);
            span(p, pf - p, "limits flags", String(flags)); p = pf;
            p = spanLeb(p, "min");
            if (flags & 1) p = spanLeb(p, "max");
          } else if (kind === 2) {
            const { value: flags, next: pf } = readU32Leb(bytes, p);
            span(p, pf - p, "limits flags", String(flags)); p = pf;
            p = spanLeb(p, "min pages");
            if (flags & 1) p = spanLeb(p, "max pages");
          } else if (kind === 3) {
            p = spanValtype(p, "global type");
            span(p, 1, "mutability", bytes[p] ? "var" : "const"); p++;
          } else if (kind === 4) {
            p = spanLeb(p, "tag type index");
          }
        }
      } else if (sectionId === 3) {
        // Function section
        const { value: count, next: p2 } = readU32Leb(bytes, p);
        span(p, p2 - p, "function count", String(count)); p = p2;
        for (let i = 0; i < count && p < sectionEnd; i++) {
          p = spanLeb(p, `func[${i}] type index`);
        }
      } else if (sectionId === 4) {
        // Table section
        const { value: count, next: p2 } = readU32Leb(bytes, p);
        span(p, p2 - p, "table count", String(count)); p = p2;
        for (let i = 0; i < count && p < sectionEnd; i++) {
          p = spanValtype(p, "reftype");
          const { value: flags, next: pf } = readU32Leb(bytes, p);
          span(p, pf - p, "limits flags", String(flags)); p = pf;
          p = spanLeb(p, "min");
          if (flags & 1) p = spanLeb(p, "max");
        }
      } else if (sectionId === 5) {
        // Memory section
        const { value: count, next: p2 } = readU32Leb(bytes, p);
        span(p, p2 - p, "memory count", String(count)); p = p2;
        for (let i = 0; i < count && p < sectionEnd; i++) {
          const { value: flags, next: pf } = readU32Leb(bytes, p);
          span(p, pf - p, "limits flags", String(flags)); p = pf;
          p = spanLeb(p, "min pages");
          if (flags & 1) p = spanLeb(p, "max pages");
        }
      } else if (sectionId === 6) {
        // Global section
        const { value: count, next: p2 } = readU32Leb(bytes, p);
        span(p, p2 - p, "global count", String(count)); p = p2;
        for (let i = 0; i < count && p < sectionEnd; i++) {
          p = spanValtype(p, "global type");
          span(p, 1, "mutability", bytes[p] ? "var" : "const"); p++;
          p = parseInitExpr(p);
        }
      } else if (sectionId === 7) {
        // Export section
        const { value: count, next: p2 } = readU32Leb(bytes, p);
        span(p, p2 - p, "export count", String(count)); p = p2;
        const EXPORT_KIND: Record<number, string> = { 0: "func", 1: "table", 2: "memory", 3: "global" };
        for (let i = 0; i < count && p < sectionEnd; i++) {
          const { next: p3 } = spanName(p, "export name"); p = p3;
          span(p, 1, "export kind", EXPORT_KIND[bytes[p]] ?? String(bytes[p])); p++;
          p = spanLeb(p, "export index");
        }
      } else if (sectionId === 8) {
        // Start section
        p = spanLeb(p, "start function index");
      } else if (sectionId === 9) {
        // Element section
        const { value: count, next: p2 } = readU32Leb(bytes, p);
        span(p, p2 - p, "element count", String(count)); p = p2;
        for (let i = 0; i < count && p < sectionEnd; i++) {
          const { value: flags, next: pf } = readU32Leb(bytes, p);
          span(p, pf - p, "elem flags", String(flags)); p = pf;
          if (flags === 0) {
            p = parseInitExpr(p); // offset expr
            const { value: ec, next: pe } = readU32Leb(bytes, p);
            span(p, pe - p, "elem count", String(ec)); p = pe;
            for (let j = 0; j < ec; j++) p = spanLeb(p, "func index");
          } else {
            // Other element flag variants — skip remaining
            if (p < sectionEnd) span(p, sectionEnd - p, "element data");
            p = sectionEnd;
          }
        }
      } else if (sectionId === 10) {
        // Code section
        const { value: count, next: p2 } = readU32Leb(bytes, p);
        span(p, p2 - p, "function count", String(count)); p = p2;
        for (let i = 0; i < count && p < sectionEnd; i++) {
          const bodyStart = p;
          const { value: bodySize, next: codeStart } = readU32Leb(bytes, p);
          span(p, codeStart - p, "body size", String(bodySize)); p = codeStart;
          const bodyEnd = codeStart + bodySize;

          // Local declarations
          const { value: localGroupCount, next: pl } = readU32Leb(bytes, p);
          span(p, pl - p, "local group count", String(localGroupCount)); p = pl;
          for (let j = 0; j < localGroupCount && p < bodyEnd; j++) {
            const { value: lc, next: plc } = readU32Leb(bytes, p);
            span(p, plc - p, "local count", String(lc)); p = plc;
            p = spanValtype(p, "local type");
          }

          // Instructions
          while (p < bodyEnd) {
            const opStart = p;
            const opcode = bytes[p++];

            if (opcode === 0xfc) {
              // Extended opcode prefix
              const { value: extOp, next: pe } = readU32Leb(bytes, p);
              const name = FC_OPCODES[extOp] ?? `fc.${extOp}`;
              span(opStart, pe - opStart, name);
              p = pe;
              // Some FC ops have trailing immediates
              if (extOp >= 8 && extOp <= 17) {
                p = spanLeb(p, "index");
                if (extOp === 8 || extOp === 10 || extOp === 12 || extOp === 14) {
                  p = spanLeb(p, "index");
                }
              }
              continue;
            }

            const info = OPCODE_MAP.get(opcode);
            if (!info) {
              span(opStart, 1, `unknown opcode`, `0x${opcode.toString(16)}`);
              continue;
            }

            switch (info.imm) {
              case N:
                span(opStart, 1, info.name);
                break;
              case L: {
                const { value, next } = readU32Leb(bytes, p);
                span(opStart, next - opStart, info.name, String(value));
                p = next;
                break;
              }
              case SL: {
                const { value, next } = readS32Leb(bytes, p);
                span(opStart, next - opStart, info.name, String(value));
                p = next;
                break;
              }
              case SL64: {
                const { value, next } = readS64Leb(bytes, p);
                span(opStart, next - opStart, info.name, String(value));
                p = next;
                break;
              }
              case F32: {
                const view = new DataView(bytes.buffer, bytes.byteOffset + p, 4);
                span(opStart, 5, info.name, String(view.getFloat32(0, true)));
                p += 4;
                break;
              }
              case F64: {
                const view = new DataView(bytes.buffer, bytes.byteOffset + p, 8);
                span(opStart, 9, info.name, String(view.getFloat64(0, true)));
                p += 8;
                break;
              }
              case MEM: {
                const { value: align, next: pa } = readU32Leb(bytes, p);
                const { value: offset, next: po } = readU32Leb(bytes, pa);
                span(opStart, po - opStart, info.name, `align=${align} offset=${offset}`);
                p = po;
                break;
              }
              case BLK: {
                // Block type: 0x40 = void, valtype, or signed LEB type index
                const bt = bytes[p];
                if (bt === 0x40 || VALTYPE_NAMES[bt]) {
                  span(opStart, 2, info.name, bt === 0x40 ? "void" : valtype(bt));
                  p++;
                } else {
                  const { value: typeIdx, next: pt } = readS32Leb(bytes, p);
                  span(opStart, pt - opStart, info.name, `type[${typeIdx}]`);
                  p = pt;
                }
                break;
              }
              case BRT: {
                const { value: count, next: pc } = readU32Leb(bytes, p);
                p = pc;
                for (let j = 0; j <= count; j++) {
                  const { next: pl2 } = readU32Leb(bytes, p);
                  p = pl2;
                }
                span(opStart, p - opStart, info.name, `${count + 1} targets`);
                break;
              }
              case CI: {
                const { value: typeIdx, next: pt } = readU32Leb(bytes, p);
                const tableIdx = bytes[pt];
                span(opStart, pt + 1 - opStart, info.name, `type[${typeIdx}] table[${tableIdx}]`);
                p = pt + 1;
                break;
              }
              case B:
                span(opStart, 2, info.name, String(bytes[p]));
                p++;
                break;
            }
          }
        }
      } else if (sectionId === 11) {
        // Data section
        const { value: count, next: p2 } = readU32Leb(bytes, p);
        span(p, p2 - p, "data segment count", String(count)); p = p2;
        for (let i = 0; i < count && p < sectionEnd; i++) {
          const { value: flags, next: pf } = readU32Leb(bytes, p);
          span(p, pf - p, "segment flags", String(flags)); p = pf;
          if (flags === 0) {
            p = parseInitExpr(p);
          } else if (flags === 2) {
            p = spanLeb(p, "memory index");
            p = parseInitExpr(p);
          }
          // passive (1) has no expr
          const { value: dataLen, next: pd } = readU32Leb(bytes, p);
          span(p, pd - p, "data length", String(dataLen)); p = pd;
          if (dataLen > 0) {
            span(p, dataLen, "data bytes");
            p += dataLen;
          }
        }
      } else if (sectionId === 12) {
        // DataCount section
        p = spanLeb(p, "data count");
      }
    } catch {
      // If parsing fails mid-section, span remaining bytes
      if (p < sectionEnd) span(p, sectionEnd - p, "unparsed");
    }

    pos = sectionEnd;
  }

  return spans;
}

// ─── Treemap widget ─────────────────────────────────────────────────────

export class WasmTreemap {
  private container: HTMLElement;
  private tooltip: HTMLElement;
  private treemapEl: HTMLElement;
  private infoBar: HTMLElement;
  private breadcrumbsBar: HTMLElement;
  private controlsBar: HTMLElement;

  private wasmData: WasmData | null = null;
  private treeRoot: TreeNode | null = null;
  private totalFileSize = 0;
  private viewMode: ViewMode = "sections";
  private thresholdPct = 0;

  private nextNodeId = 0;
  private nodeById = new Map<number, TreeNode>();
  private colorMap = new Map<string, [number, number, number]>();
  private colorIdx = 0;
  private zoomStack: {
    nodeId: number;
    crateRgb: [number, number, number] | null;
    name: string;
  }[] = [];

  onNodeSelect: ((node: { name: string; fullPath: string; isLeaf: boolean }) => void) | null = null;
  onNodeHover: ((node: { name: string; fullPath: string; isLeaf: boolean } | null) => void) | null = null;

  private highlightedEl: HTMLElement | null = null;

  /** Highlight a treemap tile by name or path. Pass null to clear. */
  highlightNode(nameOrPath: string | null) {
    if (this.highlightedEl) {
      this.highlightedEl.classList.remove("tm-highlight");
      this.highlightedEl = null;
    }
    if (!nameOrPath) return;
    // Search all tile elements for a matching node
    const els = this.treemapEl.querySelectorAll<HTMLElement>(".tm-node");
    for (const el of els) {
      const node = (el as any)._tmNode as TreeNode | undefined;
      if (!node) continue;
      if (node.fullPath === nameOrPath || node.name === nameOrPath) {
        el.classList.add("tm-highlight");
        this.highlightedEl = el;
        return;
      }
    }
  }

  private resizeObserver: ResizeObserver;
  private resizeTimer = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    container.innerHTML = "";
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.overflow = "hidden";

    // Controls bar (view toggle + threshold)
    this.controlsBar = document.createElement("div");
    this.controlsBar.className = "tm-controls";
    this.controlsBar.innerHTML = `
      <div class="tm-view-toggle">
        <button class="tm-toggle active" data-mode="sections">Sections</button>
        <button class="tm-toggle" data-mode="functions">Functions</button>
      </div>
      <div class="tm-threshold">
        <label>Remainder:</label>
        <input type="range" min="0" max="20" value="0" step="0.5">
        <span>0%</span>
      </div>
    `;
    container.appendChild(this.controlsBar);

    // Info bar
    this.infoBar = document.createElement("div");
    this.infoBar.className = "tm-info-bar";
    this.infoBar.style.display = "none";
    container.appendChild(this.infoBar);

    // Breadcrumbs
    this.breadcrumbsBar = document.createElement("div");
    this.breadcrumbsBar.className = "tm-breadcrumbs";
    container.appendChild(this.breadcrumbsBar);

    // Treemap area
    this.treemapEl = document.createElement("div");
    this.treemapEl.className = "tm-treemap";
    container.appendChild(this.treemapEl);

    // Empty state
    this.showEmpty();

    // Tooltip (appended to body to avoid clipping)
    this.tooltip = document.createElement("div");
    this.tooltip.className = "tm-tooltip";
    this.tooltip.innerHTML = `
      <div class="tm-tt-path"></div>
      <div class="tm-tt-row"><span class="tm-tt-label">Size</span><span class="tm-tt-value"></span></div>
      <div class="tm-tt-row"><span class="tm-tt-label">% of file</span><span class="tm-tt-value"></span></div>
      <div class="tm-tt-row tm-tt-parent"><span class="tm-tt-label">% of parent</span><span class="tm-tt-value"></span></div>
      <div class="tm-tt-row tm-tt-children" style="display:none"><span class="tm-tt-label">Children</span><span class="tm-tt-value"></span></div>
      <div class="tm-tt-hint"></div>
    `;
    document.body.appendChild(this.tooltip);

    // Wire controls
    this.controlsBar.querySelectorAll(".tm-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.viewMode = (btn as HTMLElement).dataset.mode as ViewMode;
        this.controlsBar
          .querySelectorAll(".tm-toggle")
          .forEach((b) =>
            b.classList.toggle(
              "active",
              (b as HTMLElement).dataset.mode === this.viewMode,
            ),
          );
        if (this.wasmData) this.rebuild();
      });
    });

    const slider = this.controlsBar.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    const sliderVal = this.controlsBar.querySelector(
      ".tm-threshold span",
    ) as HTMLSpanElement;
    slider.addEventListener("input", () => {
      this.thresholdPct = parseFloat(slider.value);
      sliderVal.textContent = this.thresholdPct + "%";
      if (this.treeRoot) this.renderCurrentView();
    });

    // Escape to zoom out
    this.onKeyDown = this.onKeyDown.bind(this);
    document.addEventListener("keydown", this.onKeyDown);

    // Resize
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        if (this.treeRoot) this.renderCurrentView();
      }, 100);
    });
    this.resizeObserver.observe(this.treemapEl);
  }

  private showEmpty() {
    this.treemapEl.innerHTML = `
      <div class="tm-empty">
        <p>Compile to see binary treemap</p>
      </div>
    `;
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && this.zoomStack.length > 0) {
      this.zoomStack.pop();
      this.renderCurrentView();
    }
  }

  /** Load a compiled wasm binary and render the treemap */
  loadBinary(binary: Uint8Array) {
    this.wasmData = parseWasm(binary.buffer);
    this.rebuild();
  }

  private rebuild() {
    const data = this.wasmData!;
    this.totalFileSize = data.fileSize;
    this.treeRoot =
      this.viewMode === "functions"
        ? this.buildFunctionsTree(data)
        : this.buildSectionsTree(data);

    // Info bar
    const codeSection = data.sections.find((s) => s.id === 10);
    this.infoBar.style.display = "flex";
    this.infoBar.textContent = [
      `${formatSize(data.fileSize)}`,
      `Code: ${formatSize(codeSection ? codeSection.totalSize : 0)}`,
      `${data.functionBodies.length} funcs`,
      `${data.imports.length} imports`,
      `${data.exports.length} exports`,
    ].join("  \u00b7  ");

    this.zoomStack = [];
    this.renderCurrentView();
  }

  // ─── Tree building ────────────────────────────────────────────────────

  private makeNode(name: string, fullPath: string): TreeNode {
    const id = this.nextNodeId++;
    const node: TreeNode = {
      _id: id,
      name,
      children: {},
      size: 0,
      fullPath,
      isLeaf: false,
      isRemainder: false,
    };
    this.nodeById.set(id, node);
    return node;
  }

  private assignColor(name: string): [number, number, number] {
    if (SECTION_COLORS[name]) return SECTION_COLORS[name];
    if (this.colorMap.has(name)) return this.colorMap.get(name)!;
    const rgb = HUE_PALETTE[this.colorIdx % HUE_PALETTE.length];
    this.colorIdx++;
    this.colorMap.set(name, rgb);
    return rgb;
  }

  private getFunctionName(data: WasmData, bodyIndex: number): string {
    const globalIdx = data.importFuncCount + bodyIndex;
    const debugName = data.functionNames.get(globalIdx);
    const exportName = data.exportNames.get(globalIdx);
    if (debugName && exportName && debugName !== exportName)
      return `${exportName} (${debugName})`;
    return exportName || debugName || `func[${globalIdx}]`;
  }

  private buildSectionsTree(data: WasmData): TreeNode {
    this.nextNodeId = 0;
    this.nodeById.clear();
    this.colorMap.clear();
    this.colorIdx = 0;

    const root = this.makeNode("root", "root");
    root.isRoot = true;

    if (data.headerSize > 0) {
      const hdr = this.makeNode("header", "header");
      hdr.size = data.headerSize;
      hdr.isLeaf = true;
      root.children["header"] = hdr;
      root.size += data.headerSize;
      this.assignColor("header");
    }

    for (const section of data.sections) {
      const sName = section.name;
      this.assignColor(sName.split(":")[0].split('"')[0]);

      const sNode = this.makeNode(sName, sName);
      sNode.size = section.totalSize;

      if (section.id === 10 && data.functionBodies.length > 0) {
        let overhead = section.totalSize;
        for (const body of data.functionBodies) {
          const fname = this.getFunctionName(data, body.index);
          const fNode = this.makeNode(fname, `${sName}/${fname}`);
          fNode.size = body.totalSize;
          fNode.isLeaf = true;
          sNode.children[`func_${body.index}`] = fNode;
          overhead -= body.totalSize;
        }
        if (overhead > 0) {
          const oh = this.makeNode("[section overhead]", `${sName}/[overhead]`);
          oh.size = overhead;
          oh.isLeaf = true;
          sNode.children["__overhead__"] = oh;
        }
      } else if (section.id === 2 && data.imports.length > 0) {
        const byModule: Record<string, WasmImport[]> = {};
        for (const imp of data.imports) {
          if (!byModule[imp.module]) byModule[imp.module] = [];
          byModule[imp.module].push(imp);
        }
        let accounted = 0;
        for (const [mod, imps] of Object.entries(byModule)) {
          this.assignColor(mod);
          const modNode = this.makeNode(mod, `${sName}/${mod}`);
          for (const imp of imps) {
            const label = `${imp.name} [${imp.kind}]`;
            const iNode = this.makeNode(label, `${sName}/${mod}/${label}`);
            iNode.size = imp.size || 1;
            iNode.isLeaf = true;
            modNode.children[`imp_${imp.index}_${imp.kind}`] = iNode;
            modNode.size += iNode.size;
          }
          sNode.children[`mod_${mod}`] = modNode;
          accounted += modNode.size;
        }
        const overhead = section.totalSize - accounted;
        if (overhead > 0) {
          const oh = this.makeNode("[section overhead]", `${sName}/[overhead]`);
          oh.size = overhead;
          oh.isLeaf = true;
          sNode.children["__overhead__"] = oh;
        }
      } else {
        sNode.isLeaf = true;
      }

      root.children[`section_${section.id}_${section.offset}`] = sNode;
      root.size += section.totalSize;
    }

    return root;
  }

  private buildFunctionsTree(data: WasmData): TreeNode {
    this.nextNodeId = 0;
    this.nodeById.clear();
    this.colorMap.clear();
    this.colorIdx = 0;

    const root = this.makeNode("root", "root");
    root.isRoot = true;

    if (data.functionBodies.length > 0) {
      for (const body of data.functionBodies) {
        const globalIdx = data.importFuncCount + body.index;
        const name = this.getFunctionName(data, body.index);
        const isExported = data.exportNames.has(globalIdx);

        const parts = name.replace(/^\$/, "").split(/[./:]+/);
        let parent = root;
        if (parts.length > 1) {
          let path = "";
          for (let i = 0; i < parts.length - 1; i++) {
            path += (path ? "/" : "") + parts[i];
            const key = `group_${path}`;
            if (!parent.children[key]) {
              this.assignColor(parts[i]);
              parent.children[key] = this.makeNode(parts[i], path);
            }
            parent.children[key].size += body.totalSize;
            parent = parent.children[key];
          }
        }

        const leafName = parts.length > 1 ? parts[parts.length - 1] : name;
        const tag = isExported ? " [export]" : "";
        this.assignColor(name);
        const fNode = this.makeNode(leafName + tag, name);
        fNode.size = body.totalSize;
        fNode.isLeaf = true;
        parent.children[`func_${body.index}`] = fNode;
        root.size += body.totalSize;
      }
    }

    if (data.imports.length > 0) {
      const impNode = this.makeNode("[imports]", "imports");
      this.assignColor("import");
      for (const imp of data.imports) {
        if (imp.kind !== "func") continue;
        const label = `${imp.module}::${imp.name}`;
        const iNode = this.makeNode(label, `imports/${label}`);
        iNode.size = imp.size || 1;
        iNode.isLeaf = true;
        impNode.children[`imp_${imp.index}`] = iNode;
        impNode.size += iNode.size;
      }
      if (impNode.size > 0) {
        root.children["__imports__"] = impNode;
        root.size += impNode.size;
      }
    }

    const codeSize = data.functionBodies.reduce((s, b) => s + b.totalSize, 0);
    const overhead = data.fileSize - codeSize;
    if (overhead > 0) {
      const oh = this.makeNode("[non-code sections]", "overhead");
      oh.size = overhead;
      oh.isLeaf = true;
      root.children["__overhead__"] = oh;
      root.size += overhead;
    }

    return root;
  }

  // ─── Remainder grouping ───────────────────────────────────────────────

  private applyRemainders(node: TreeNode, threshPct: number) {
    const childArr = Object.values(node.children);
    if (childArr.length === 0) return;
    const threshold = node.size * (threshPct / 100);
    const sorted = childArr.slice().sort((a, b) => b.size - a.size);
    const keep: TreeNode[] = [],
      small: TreeNode[] = [];
    for (const child of sorted) {
      (child.size < threshold ? small : keep).push(child);
    }
    const remainderSize = small.reduce((s, c) => s + c.size, 0);
    const remainderTooBig = remainderSize > node.size * 0.15;
    if (keep.length === 0 || remainderTooBig || small.length < 2) {
      for (const child of childArr) {
        if (!child.isLeaf) this.applyRemainders(child, threshPct);
      }
      return;
    }
    for (const child of keep) {
      if (!child.isLeaf) this.applyRemainders(child, threshPct);
    }
    node.children = {};
    for (const k of keep) node.children["_k_" + k._id] = k;
    if (small.length > 0) {
      node.children["__remainder__"] = {
        _id: -1,
        _originalId: -1,
        name: `[${small.length} smaller items]`,
        children: {},
        size: remainderSize,
        fullPath: node.fullPath + "/[other]",
        isLeaf: true,
        isRemainder: true,
        remainderCount: small.length,
      };
    }
  }

  private deepCloneTree(node: TreeNode): TreeNode {
    const clone: TreeNode = {
      ...node,
      _originalId: node._id,
      children: {},
    };
    for (const [k, v] of Object.entries(node.children)) {
      clone.children[k] = this.deepCloneTree(v);
    }
    return clone;
  }

  // ─── Squarify layout ─────────────────────────────────────────────────

  private squarify(
    items: { size: number; node: TreeNode }[],
    x: number,
    y: number,
    w: number,
    h: number,
  ): LayoutItem[] {
    if (items.length === 0) return [];
    const total = items.reduce((s, i) => s + i.size, 0);
    if (total <= 0 || w <= 0 || h <= 0) return [];
    const sorted = items.slice().sort((a, b) => b.size - a.size);
    const result: LayoutItem[] = [];
    this.layoutRows(sorted, x, y, w, h, total, result);
    return result;
  }

  private layoutRows(
    items: { size: number; node: TreeNode }[],
    x: number,
    y: number,
    w: number,
    h: number,
    total: number,
    result: LayoutItem[],
  ) {
    if (items.length === 0) return;
    if (items.length === 1) {
      result.push({ ...items[0], x, y, w, h });
      return;
    }
    const vertical = h > w;
    const mainLen = vertical ? h : w;
    const crossLen = vertical ? w : h;
    const rowItems: { size: number; node: TreeNode }[] = [];
    let rowSize = 0,
      bestWorst = Infinity,
      bestN = 1;
    for (let i = 0; i < items.length; i++) {
      rowItems.push(items[i]);
      rowSize += items[i].size;
      const rowDim = (rowSize / total) * mainLen;
      let worst = 0;
      for (const ri of rowItems) {
        const itemCross = (ri.size / rowSize) * crossLen;
        if (rowDim > 0 && itemCross > 0) {
          worst = Math.max(
            worst,
            Math.max(rowDim / itemCross, itemCross / rowDim),
          );
        } else worst = Infinity;
      }
      if (worst <= bestWorst) {
        bestWorst = worst;
        bestN = i + 1;
      } else break;
    }
    const row = items.slice(0, bestN);
    const rest = items.slice(bestN);
    const rSize = row.reduce((s, i) => s + i.size, 0);
    const rowDim = (rSize / total) * mainLen;
    let offset = 0;
    for (const item of row) {
      const itemCross = (item.size / rSize) * crossLen;
      if (vertical)
        result.push({ ...item, x: x + offset, y, w: itemCross, h: rowDim });
      else result.push({ ...item, x, y: y + offset, w: rowDim, h: itemCross });
      offset += itemCross;
    }
    if (rest.length > 0) {
      const restTotal = total - rSize;
      if (vertical)
        this.layoutRows(rest, x, y + rowDim, w, h - rowDim, restTotal, result);
      else
        this.layoutRows(rest, x + rowDim, y, w - rowDim, h, restTotal, result);
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  private static HEADER_H = 20;
  private static MIN_LABEL_W = 35;
  private static MIN_LABEL_H = 16;
  private static MIN_CHILD_AREA = 600;

  private getNodeColor(node: TreeNode): [number, number, number] {
    const base = node.fullPath
      .split("/")[0]
      .split(":")[0]
      .replace(/^custom$/, "custom");
    return (
      SECTION_COLORS[base] ||
      this.colorMap.get(node.name) ||
      this.colorMap.get(base) || [80, 80, 100]
    );
  }

  private renderTreemap(
    rootNode: TreeNode,
    container: HTMLElement,
    initialRgb: [number, number, number] | null,
  ) {
    container.innerHTML = "";
    const rect = container.getBoundingClientRect();
    this.renderNode(
      rootNode,
      container,
      0,
      0,
      rect.width,
      rect.height,
      0,
      initialRgb,
      rootNode.size,
    );
  }

  private renderNode(
    node: TreeNode,
    container: HTMLElement,
    x: number,
    y: number,
    w: number,
    h: number,
    depth: number,
    crateRgb: [number, number, number] | null,
    parentSize: number,
  ) {
    if (w < 2 || h < 2) return;
    const children = Object.values(node.children);
    const hasChildren = children.length > 0 && !node.isLeaf;
    const isLeaf = !hasChildren;

    // Shrink top-level sections to create black gap between them;
    // leaf nodes use inner inset instead
    if (!isLeaf && depth === 1) {
      x += 1; y += 1; w -= 2; h -= 2;
    }

    if (!crateRgb) crateRgb = this.getNodeColor(node);
    if (depth === 1 && !crateRgb) crateRgb = [80, 80, 100];
    const baseRgb = crateRgb || [80, 80, 100];

    const el = document.createElement("div");
    el.className =
      "tm-node" +
      (isLeaf ? " tm-leaf" : " tm-branch") +
      (node.isRemainder ? " tm-remainder" : "");
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.width = w + "px";
    el.style.height = h + "px";

    const inner = document.createElement("div");
    inner.className = "tm-node-inner";
    const bw = isLeaf ? Math.max(1, 3 - depth) : 0;
    inner.style.inset = bw + "px";

    if (depth === 0) {
      inner.style.background = "transparent";
      el.style.background = "transparent";
    } else {
      el.style.background = "#000";
      if (node.isRemainder) {
        inner.style.background = isLeaf ? "rgb(60,60,60)" : "#000";
      } else if (isLeaf) {
        const dim = 0.65;
        inner.style.background = rgbStr([
          Math.round(baseRgb[0] * dim),
          Math.round(baseRgb[1] * dim),
          Math.round(baseRgb[2] * dim),
        ]);
      } else {
        // Branch inner is black so leaf gaps show black separators
        inner.style.background = "#000";
      }
    }

    const canLabel = w > WasmTreemap.MIN_LABEL_W && h > WasmTreemap.MIN_LABEL_H;
    let headerH = 0;
    if (canLabel && !isLeaf && depth > 0) {
      const label = document.createElement("div");
      label.className = "tm-label";
      label.innerHTML = `<span>${esc(node.name)}</span> <span class="tm-label-size">${formatSize(node.size)}</span>`;
      label.style.color = "#fff";
      const headerDim = depth > 1 ? 0.8 : 1;
      label.style.background = node.isRemainder
        ? "rgb(80,80,80)"
        : rgbStr([
            Math.round(baseRgb[0] * headerDim),
            Math.round(baseRgb[1] * headerDim),
            Math.round(baseRgb[2] * headerDim),
          ]);
      label.style.height = WasmTreemap.HEADER_H + "px";
      label.style.bottom = "auto";
      label.style.borderBottom = "1px solid rgba(0,0,0,0.3)";
      label.style.zIndex = "2";
      el.appendChild(label);
      headerH = WasmTreemap.HEADER_H + 2;
    } else if (canLabel && isLeaf) {
      const label = document.createElement("div");
      label.className = "tm-label";
      const fs = w < 70 ? "9px" : "11px";
      label.innerHTML = `<span>${esc(node.name)}</span> <span class="tm-label-size">${formatSize(node.size)}</span>`;
      label.style.color = "#fff";
      label.style.fontSize = fs;
      inner.appendChild(label);
    }

    (el as any)._tmNode = node;
    (el as any)._tmParentSize = parentSize;
    (el as any)._tmCrateRgb = crateRgb;

    el.addEventListener("mouseenter", (e) => this.onNodeEnter(e));
    el.addEventListener("mousemove", (e) => this.onTooltipMove(e));
    el.addEventListener("mouseleave", () => this.onNodeLeave());
    if (depth > 0) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const n = (e.currentTarget as any)._tmNode as TreeNode;
        const origId = n._originalId != null ? n._originalId : n._id;
        const origNode = origId >= 0 ? this.nodeById.get(origId) : null;
        if (this.onNodeSelect && origNode) {
          this.onNodeSelect({ name: origNode.name, fullPath: origNode.fullPath, isLeaf: origNode.isLeaf });
        }
        if (!isLeaf) this.onNodeClick(e);
      });
    }

    el.appendChild(inner);
    container.appendChild(el);

    if (hasChildren) {
      const iy = headerH;
      const iw = w,
        ih = h - iy;
      if (iw * ih >= WasmTreemap.MIN_CHILD_AREA && iw > 10 && ih > 10) {
        const childItems = children.map((c) => ({ size: c.size, node: c }));
        const laid = this.squarify(childItems, 0, 0, iw, ih);
        for (const item of laid) {
          // Round to integer pixels to avoid sub-pixel gaps
          const cx = Math.round(item.x);
          const cy = Math.round(item.y);
          const cw = Math.round(item.x + item.w) - cx;
          const ch = Math.round(item.y + item.h) - cy;
          const childRgb =
            depth === 0 ? this.getNodeColor(item.node) : crateRgb;
          this.renderNode(
            item.node,
            el,
            cx,
            iy + cy,
            cw,
            ch,
            depth + 1,
            childRgb,
            node.size,
          );
        }
      }
    }
  }

  // ─── Tooltip ──────────────────────────────────────────────────────────

  private onNodeEnter(e: MouseEvent) {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const node = (el as any)._tmNode as TreeNode;
    const parentSize = (el as any)._tmParentSize as number;

    this.tooltip.querySelector(".tm-tt-path")!.textContent =
      node.fullPath || node.name;
    const vals = this.tooltip.querySelectorAll(".tm-tt-value");
    vals[0].textContent = formatSize(node.size);
    vals[1].textContent =
      ((node.size / this.totalFileSize) * 100).toFixed(2) + "%";

    const parentRow = this.tooltip.querySelector(
      ".tm-tt-parent",
    ) as HTMLElement;
    if (parentSize && parentSize > 0) {
      vals[2].textContent = ((node.size / parentSize) * 100).toFixed(1) + "%";
      parentRow.style.display = "flex";
    } else parentRow.style.display = "none";

    const childrenRow = this.tooltip.querySelector(
      ".tm-tt-children",
    ) as HTMLElement;
    const hint = this.tooltip.querySelector(".tm-tt-hint") as HTMLElement;
    const children = Object.values(node.children || {});
    if (children.length > 0 && !node.isLeaf) {
      childrenRow.style.display = "flex";
      childrenRow.querySelector(".tm-tt-value")!.textContent =
        children.length + " items";
      hint.textContent = "Click to zoom in";
    } else {
      childrenRow.style.display = "none";
      hint.textContent = "";
    }
    if (node.isRemainder)
      hint.textContent = "Grouped items below remainder threshold";

    this.tooltip.style.display = "block";
    this.positionTooltip(e);

    if (this.onNodeHover) {
      const origId = node._originalId != null ? node._originalId : node._id;
      const origNode = origId >= 0 ? this.nodeById.get(origId) : null;
      if (origNode) {
        this.onNodeHover({ name: origNode.name, fullPath: origNode.fullPath, isLeaf: origNode.isLeaf });
      }
    }
  }

  private onTooltipMove(e: MouseEvent) {
    this.positionTooltip(e);
  }

  private onNodeLeave() {
    this.tooltip.style.display = "none";
    if (this.onNodeHover) this.onNodeHover(null);
  }

  private positionTooltip(e: MouseEvent) {
    let tx = e.clientX + 14,
      ty = e.clientY + 14;
    const tw = this.tooltip.offsetWidth,
      th = this.tooltip.offsetHeight;
    if (tx + tw > window.innerWidth - 10) tx = e.clientX - tw - 14;
    if (ty + th > window.innerHeight - 10) ty = e.clientY - th - 14;
    this.tooltip.style.left = tx + "px";
    this.tooltip.style.top = ty + "px";
  }

  // ─── Zoom / Breadcrumbs ───────────────────────────────────────────────

  private findPathTo(root: TreeNode, targetId: number): TreeNode[] {
    if (root._id === targetId) return [root];
    for (const child of Object.values(root.children)) {
      const path = this.findPathTo(child, targetId);
      if (path.length > 0) return [root, ...path];
    }
    return [];
  }

  private onNodeClick(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const node = (el as any)._tmNode as TreeNode;
    const crateRgb = (el as any)._tmCrateRgb as [number, number, number];
    const origId = node._originalId != null ? node._originalId : node._id;
    if (origId < 0) return;

    // Find the full path from current view root to clicked node
    const currentRoot = this.zoomStack.length === 0
      ? this.treeRoot!
      : this.nodeById.get(this.zoomStack[this.zoomStack.length - 1].nodeId)!;
    const path = this.findPathTo(currentRoot, origId);
    // path[0] is current root (already in stack), push all descendants
    for (let i = 1; i < path.length; i++) {
      const n = path[i];
      const rgb = this.getNodeColor(n) || crateRgb;
      this.zoomStack.push({ nodeId: n._id, crateRgb: rgb, name: n.name });
    }
    this.renderCurrentView();
  }

  private renderCurrentView() {
    let viewNode: TreeNode, crateRgb: [number, number, number] | null;
    if (this.zoomStack.length === 0) {
      viewNode = this.treeRoot!;
      crateRgb = null;
    } else {
      const top = this.zoomStack[this.zoomStack.length - 1];
      viewNode = this.nodeById.get(top.nodeId)!;
      crateRgb = top.crateRgb;
      if (!viewNode) {
        this.zoomStack = [];
        viewNode = this.treeRoot!;
        crateRgb = null;
      }
    }

    const viewCopy = this.deepCloneTree(viewNode);
    this.applyRemainders(viewCopy, this.thresholdPct);
    this.renderTreemap(viewCopy, this.treemapEl, crateRgb);

    // Breadcrumbs
    this.breadcrumbsBar.innerHTML = "";
    const rootCrumb = document.createElement("button");
    rootCrumb.className = "tm-crumb";
    rootCrumb.textContent = "root";
    rootCrumb.onclick = () => {
      this.zoomStack = [];
      this.renderCurrentView();
    };
    this.breadcrumbsBar.appendChild(rootCrumb);

    for (let i = 0; i < this.zoomStack.length; i++) {
      const sep = document.createElement("span");
      sep.className = "tm-crumb-sep";
      sep.textContent = "/";
      this.breadcrumbsBar.appendChild(sep);
      const crumb = document.createElement("button");
      crumb.className = "tm-crumb";
      crumb.textContent = this.zoomStack[i].name;
      const idx = i;
      crumb.onclick = () => {
        this.zoomStack = this.zoomStack.slice(0, idx + 1);
        this.renderCurrentView();
      };
      this.breadcrumbsBar.appendChild(crumb);
    }
  }

  dispose() {
    document.removeEventListener("keydown", this.onKeyDown);
    this.resizeObserver.disconnect();
    this.tooltip.remove();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function rgbStr([r, g, b]: [number, number, number]): string {
  return `rgb(${r},${g},${b})`;
}

function rgbaStr([r, g, b]: [number, number, number], a: number): string {
  return `rgba(${r},${g},${b},${a})`;
}
